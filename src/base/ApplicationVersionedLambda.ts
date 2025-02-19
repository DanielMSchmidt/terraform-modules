import { Resource } from 'cdktf';
import { Construct } from 'constructs';
import {
  CloudwatchLogGroup,
  DataAwsIamPolicyDocument,
  DataAwsIamPolicyDocumentStatement,
  IamPolicy,
  IamRole,
  IamRolePolicyAttachment,
  LambdaAlias,
  LambdaFunction,
  LambdaFunctionConfig,
  LambdaFunctionVpcConfig,
  S3Bucket,
  S3BucketPublicAccessBlock,
} from '@cdktf/provider-aws';
import {
  DataArchiveFile,
  DataArchiveFileSource,
} from '@cdktf/provider-archive';

export enum LAMBDA_RUNTIMES {
  PYTHON38 = 'python3.8',
  NODEJS12 = 'nodejs12.x',
  NODEJS14 = 'nodejs14.x',
}

export interface ApplicationVersionedLambdaProps {
  name: string;
  description?: string;
  runtime: LAMBDA_RUNTIMES;
  handler: string;
  timeout?: number;
  environment?: { [key: string]: string };
  vpcConfig?: LambdaFunctionVpcConfig;
  executionPolicyStatements?: DataAwsIamPolicyDocumentStatement[];
  tags?: { [key: string]: string };
  logRetention?: number;
  s3Bucket: string;
  usesCodeDeploy?: boolean;
}

const DEFAULT_TIMEOUT = 5;
const DEFAULT_RETENTION = 14;

export class ApplicationVersionedLambda extends Resource {
  public readonly versionedLambda: LambdaAlias;
  public lambdaExecutionRole: IamRole;

  constructor(
    scope: Construct,
    name: string,
    private config: ApplicationVersionedLambdaProps
  ) {
    super(scope, name);

    this.createCodeBucket();
    this.versionedLambda = this.createLambdaFunction();
  }

  private createLambdaFunction() {
    this.lambdaExecutionRole = new IamRole(this, 'execution-role', {
      name: `${this.config.name}-ExecutionRole`,
      assumeRolePolicy: this.getLambdaAssumePolicyDocument(),
    });

    const executionPolicy = new IamPolicy(this, 'execution-policy', {
      name: `${this.config.name}-ExecutionRolePolicy`,
      policy: this.getLambdaExecutionPolicyDocument(),
    });

    new IamRolePolicyAttachment(this, 'execution-role-policy-attachment', {
      role: this.lambdaExecutionRole.name,
      policyArn: executionPolicy.arn,
      dependsOn: [this.lambdaExecutionRole, executionPolicy],
    });

    const defaultLambda = this.getDefaultLambda();
    const lambdaConfig: LambdaFunctionConfig = {
      functionName: `${this.config.name}-Function`,
      filename: defaultLambda.outputPath,
      handler: this.config.handler,
      runtime: this.config.runtime,
      timeout: this.config.timeout ?? DEFAULT_TIMEOUT,
      sourceCodeHash: defaultLambda.outputBase64Sha256,
      role: this.lambdaExecutionRole.arn,
      vpcConfig: [this.config.vpcConfig],
      publish: true,
      lifecycle: {
        ignoreChanges: [
          'filename',
          'source_code_hash',
          this.shouldIgnorePublish() ? 'publish' : '',
        ].filter((v: string) => v),
      },
      tags: this.config.tags,
      environment: this.config.environment
        ? [{ variables: this.config.environment }]
        : undefined,
    };

    const lambda = new LambdaFunction(this, 'lambda', lambdaConfig);

    new CloudwatchLogGroup(this, 'log-group', {
      name: `/aws/lambda/${lambda.functionName}`,
      retentionInDays: this.config.logRetention ?? DEFAULT_RETENTION,
      dependsOn: [lambda],
    });

    const lambdaAlias = new LambdaAlias(this, 'alias', {
      functionName: lambda.functionName,
      functionVersion: lambda.version,
      name: 'DEPLOYED',
      lifecycle: {
        ignoreChanges: ['function_version'],
      },
      dependsOn: [lambda],
    });

    lambdaAlias.addOverride(
      'function_version',
      `\${split(":", ${lambda.fqn}.qualified_arn)[7]}`
    );

    return lambdaAlias;
  }

  private shouldIgnorePublish() {
    if (this.config.usesCodeDeploy !== undefined) {
      return this.config.usesCodeDeploy;
    }

    return false;
  }

  private getLambdaAssumePolicyDocument() {
    return new DataAwsIamPolicyDocument(this, 'assume-policy-document', {
      version: '2012-10-17',
      statement: [
        {
          effect: 'Allow',
          actions: ['sts:AssumeRole'],
          principals: [
            {
              identifiers: ['lambda.amazonaws.com', 'edgelambda.amazonaws.com'],
              type: 'Service',
            },
          ],
        },
      ],
    }).json;
  }

  private getLambdaExecutionPolicyDocument() {
    const document = {
      version: '2012-10-17',
      statement: [
        {
          effect: 'Allow',
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents',
            'logs:DescribeLogStreams',
          ],
          resources: ['arn:aws:logs:*:*:*'],
        },
        ...(this.config.executionPolicyStatements ?? []),
      ],
    };

    if (this.config.vpcConfig) {
      document.statement.push({
        effect: 'Allow',
        actions: [
          'ec2:DescribeNetworkInterfaces',
          'ec2:CreateNetworkInterface',
          'ec2:DeleteNetworkInterface',
          'ec2:DescribeInstances',
          'ec2:AttachNetworkInterface',
        ],
        resources: ['*'],
      });
    }

    return new DataAwsIamPolicyDocument(
      this,
      'execution-policy-document',
      document
    ).json;
  }

  private getDefaultLambda() {
    const source = this.getDefaultLambdaSource();
    return new DataArchiveFile(this, 'lambda-default-file', {
      type: 'zip',
      source: [source],
      outputPath: `${source.filename}.zip`,
    });
  }

  private getDefaultLambdaSource(): DataArchiveFileSource {
    const runtime = this.config.runtime.match(/[a-z]*/)[0];
    const handler = this.config.handler.split('.');
    const functionName = handler.pop();
    const functionFilename = handler.join('.');

    let content = `export const ${functionName} = (event, context) => { console.log(event) }`;
    let filename = `${functionFilename}.js`;

    if (runtime === 'python') {
      content = `${functionName}(event, context):\n\t print(event)`;
      filename = `${functionFilename}.py`;
    }

    return {
      content,
      filename,
    };
  }

  private createCodeBucket() {
    const codeBucket = new S3Bucket(this, 'code-bucket', {
      bucket: this.config.s3Bucket,
      acl: 'private',
      tags: this.config.tags,
      forceDestroy: true,
    });

    new S3BucketPublicAccessBlock(this, `code-bucket-public-access-block`, {
      bucket: codeBucket.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
    });
  }
}
