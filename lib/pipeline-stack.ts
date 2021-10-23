import * as cdk from "@aws-cdk/core";
import * as ecr from "@aws-cdk/aws-ecr";
import * as codepipeline from "@aws-cdk/aws-codepipeline";
import * as kms from "@aws-cdk/aws-kms";
import * as s3 from "@aws-cdk/aws-s3";
import * as iam from "@aws-cdk/aws-iam";

import {
  createSourceAction,
  createDockerBuildAction,
  createCdkBuildAction,
  createCfnDeployAction,
} from "../cdk-common/codepipeline-utils";

export interface PipelineStackProps extends cdk.StackProps {
  // basic props for cdk
  project_code: string;
  codepipeline_role_arn: string;
  cloudformation_role_arn: string;
  artifact_bucket_name: string;
  // code repo
  code_repo_name: string;
  code_repo_branch: string;
  code_repo_secret_var?: string;
  code_repo_owner?: string;
}

export class PipelineStack extends cdk.Stack {
  private project_code: string;
  private pipeline: codepipeline.Pipeline;
  private ecrRepo: ecr.IRepository;
  private key: kms.Key;

  constructor(scope: cdk.Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    this.project_code = props.project_code;
    this.ecrRepo = this.createEcrRepo(this, props.project_code);
    this.pipeline = this.createPipeline(this, props);
    this.output();
  }

  private createEcrRepo(
    stack: cdk.Stack,
    ecr_repo_name: string
  ): ecr.IRepository {
    let ecrRepo: ecr.IRepository = new ecr.Repository(
      stack,
      `${stack.stackName}-EcrREpo`,
      {
        repositoryName: ecr_repo_name,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    return ecrRepo;
  }

  private createPipeline(
    scope: cdk.Stack,
    props: PipelineStackProps
  ): codepipeline.Pipeline {
    const sourceOutput = new codepipeline.Artifact();
    const cdkBuildOutput = new codepipeline.Artifact();
    const dockerBuildOutput = new codepipeline.Artifact();

    /* Get existing resources for CDK */
    const pipelineRole = iam.Role.fromRoleArn(
      scope,
      "CodePipelineRole",
      props.codepipeline_role_arn!
    );

    const cloudFormationRole = iam.Role.fromRoleArn(
      scope,
      "CloudFormationRole",
      props.cloudformation_role_arn!
    );

    const artifactBucket = this.getArtifactBucket({ ...props });

    /* Create codepipeline */
    return new codepipeline.Pipeline(scope, `${props.project_code}-pipeline`, {
      artifactBucket,
      role: pipelineRole,
      pipelineName: props.project_code,
      stages: [
        {
          stageName: "Source",
          actions: [createSourceAction(sourceOutput, { ...props })],
        },
        {
          stageName: "Build",
          actions: [
            createCdkBuildAction(
              this,
              sourceOutput,
              cdkBuildOutput,
              pipelineRole
            ),
            createDockerBuildAction(
              this,
              sourceOutput,
              dockerBuildOutput,
              pipelineRole,
              {
                repositoryUri: this.ecrRepo.repositoryUri,
                containerName: "",
              }
            ),
          ],
        },
        {
          stageName: "Deploy",
          actions: [
            createCfnDeployAction(
              cdkBuildOutput,
              `${props.project_code}-fargate`,
              cloudFormationRole,
              [],
              1
            ),
            createCfnDeployAction(
              cdkBuildOutput,
              `${props.project_code}-deployment`,
              cloudFormationRole,
              [],
              2
            ),
          ],
        },
      ],
    });
  }

  private getArtifactBucket(props: {
    project_code: string;
    artifact_bucket_name: string;
  }): s3.IBucket {
    /* Create a new KMS key */
    this.key = new kms.Key(this, `${props.project_code}-key`, {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      alias: `${props.project_code}-key`,
    });

    return s3.Bucket.fromBucketAttributes(this, "ArtifactBucket", {
      bucketName: props.artifact_bucket_name,
      encryptionKey: this.key,
    });
  }

  // private createSourceAction(
  //   output: codepipeline.Artifact,
  //   props: {
  //     code_repo_name: string;
  //     code_repo_branch: string;
  //     code_repo_owner?: string;
  //     code_repo_secret_var?: string;
  //   }
  // ): codepipeline_actions.GitHubSourceAction {
  //   const githubAction = new codepipeline_actions.GitHubSourceAction({
  //     actionName: "Github_Source",
  //     repo: props.code_repo_name,
  //     branch: props.code_repo_branch,
  //     owner: props.code_repo_owner!,
  //     oauthToken: cdk.SecretValue.secretsManager(props.code_repo_secret_var!),
  //     output: output,
  //   });
  //   return githubAction;
  // }

  // private createCdkBuildAction(
  //   input: codepipeline.Artifact,
  //   output: codepipeline.Artifact,
  //   role: iam.IRole,
  //   runOrder: number = 1
  // ): codepipeline_actions.CodeBuildAction {
  //   const project = createCdkBuildProject(this, "CdkBuildProject");
  //   // Add additional permissions to role
  //   project.role?.addToPrincipalPolicy(
  //     new iam.PolicyStatement({
  //       effect: iam.Effect.ALLOW,
  //       resources: ["*"],
  //       actions: ["ec2:DescribeAvailabilityZones"],
  //     })
  //   );
  //   project.role?.addToPrincipalPolicy(
  //     new iam.PolicyStatement({
  //       effect: iam.Effect.ALLOW,
  //       resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/cdk-*`],
  //       actions: ["sts:AssumeRole"],
  //     })
  //   );
  //   const buildAction = new codepipeline_actions.CodeBuildAction({
  //     actionName: "CdkBuild_Action",
  //     project: project,
  //     input: input,
  //     outputs: [output],
  //     role: role,
  //     runOrder: runOrder,
  //   });

  //   return buildAction;
  // }

  // private createDockerBuildAction(
  //   input: codepipeline.Artifact,
  //   output: codepipeline.Artifact,
  //   role: iam.IRole,
  //   props: { repositoryUri: string; containerName: string },
  //   runOrder: number = 1
  // ): codepipeline_actions.CodeBuildAction {
  //   const project = new codebuild.PipelineProject(this, "CodeBuildProject", {
  //     environment: {
  //       buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
  //       privileged: true,
  //     },
  //     buildSpec: this.createBuildSpecFromFile("./buildspec.yml"),
  //     environmentVariables: {
  //       REPOSITORY_URI: { value: props.repositoryUri },
  //       CONTAINER_NAME: { value: props.containerName },
  //     },
  //   });
  //   // this.ecrRepo.grantPullPush(project.grantPrincipal);
  //   project.role?.addManagedPolicy(
  //     iam.ManagedPolicy.fromAwsManagedPolicyName(
  //       "AmazonEC2ContainerRegistryPowerUser"
  //     )
  //   );

  //   const buildAction = new codepipeline_actions.CodeBuildAction({
  //     actionName: "DockerBuild_Action",
  //     project: project,
  //     input: input,
  //     outputs: [output],
  //     role: role,
  //     runOrder: runOrder,
  //   });

  //   return buildAction;
  // }

  // private createCfnDeployAction(
  //   cdkBuildOutput: codepipeline.Artifact,
  //   stackName: string,
  //   cloudformationRole: iam.IRole,
  //   extraInputs: codepipeline.Artifact[] = [],
  //   runOrder: number = 1
  // ): codepipeline_actions.CloudFormationCreateUpdateStackAction {
  //   return new codepipeline_actions.CloudFormationCreateUpdateStackAction({
  //     actionName: `Deploy-${stackName}`,
  //     // Must be the same as the other stack name, e.g. `${props.project_code}-fargate`
  //     stackName: stackName,
  //     templatePath: cdkBuildOutput.atPath(
  //       // Must be the same name as LambdaStack, e.g. `${stackName}.template.json`
  //       `${stackName}.template.json`
  //     ),
  //     adminPermissions: true,
  //     parameterOverrides: {
  //       // Pass location of lambda code to Lambda Stack
  //       // ...props.lambda_code.assign(
  //       //   dockerBuildOutput.getParam(
  //       //     "imagedefinitions.json",
  //       //     "imagedefinitions"
  //       //   )
  //       // ),
  //     },
  //     extraInputs: extraInputs,
  //     deploymentRole: cloudformationRole,
  //     runOrder: runOrder,
  //   });
  // }

  private output() {
    new cdk.CfnOutput(this, "BucketKmsKeyArn", {
      value: this.key.keyArn,
      exportName: `${this.project_code}-BucketKmsKeyArn`,
    });
    new cdk.CfnOutput(this, "EcrRepositoryName", {
      value: this.ecrRepo.repositoryName,
      exportName: `${this.project_code}-EcrRepositoryName`,
    });
    new cdk.CfnOutput(this, "PipelineName", {
      value: this.pipeline.pipelineName,
      exportName: `${this.project_code}-PipelineName`,
    });
  }
}
