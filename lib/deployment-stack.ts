import * as cdk from "@aws-cdk/core";
import * as ecs from "@aws-cdk/aws-ecs";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as ecr from "@aws-cdk/aws-ecr";
import * as codebuild from "@aws-cdk/aws-codebuild";
import * as codepipeline from "@aws-cdk/aws-codepipeline";
import * as codepipeline_actions from "@aws-cdk/aws-codepipeline-actions";
import * as kms from "@aws-cdk/aws-kms";
import * as s3 from "@aws-cdk/aws-s3";
import * as iam from "@aws-cdk/aws-iam";
import { ManagedPolicy } from "@aws-cdk/aws-iam";

export interface DeploymentStackProps extends cdk.StackProps {
  // basic props
  project_code: string;
  codepipeline_role_arn?: string;
  cloudformation_role_arn: string;
  artifact_bucket_name: string;
  // repo
  code_repo_name: string;
  code_repo_branch: string;
  code_repo_secret_var?: string;
  code_repo_owner?: string;
  // others
  readonly vpc_id: string;
}

export class DeploymentStack extends cdk.Stack {
  public readonly pipeline: codepipeline.Pipeline;
  public readonly ecrRepo: ecr.IRepository;
  public importedFargateService: ecs.FargateService;
  readonly project_code: string;

  constructor(scope: cdk.Construct, id: string, props: DeploymentStackProps) {
    super(scope, id, props);

    this.project_code = props.project_code;

    /* Get existing ECR Repo */
    this.ecrRepo = ecr.Repository.fromRepositoryName(
      this,
      `${this.stackName}-EcrREpo`,
      cdk.Fn.importValue(`${this.project_code}-EcrRepositoryName`)
    );

    this.pipeline = this.createPipeline(this, props);
    this.output();
  }

  private createPipeline(
    scope: cdk.Stack,
    props: DeploymentStackProps
  ): codepipeline.Pipeline {
    const sourceOutput = new codepipeline.Artifact();
    const dockerBuildOutput = new codepipeline.Artifact();

    /* Create existing CodePipeline role */
    const pipelineRole = iam.Role.fromRoleArn(
      scope,
      "CodePipelineRole",
      props.codepipeline_role_arn!
    );

    /* Use existing S3 bucket */
    const artifactBucket = this.getArtifactBucket({ ...props });
    const containerName = cdk.Fn.importValue(
      `${this.project_code}-FargateClusterContainerName`
    );

    // const repositoryUri = `${cdk.Aws.ACCOUNT_ID}.dkr.ecr.${cdk.Aws.REGION}.amazonaws.com/aws-cdk/${props.project_code}`;
    return new codepipeline.Pipeline(scope, `${props.project_code}-pipeline`, {
      artifactBucket,
      role: pipelineRole,
      pipelineName: `${props.project_code}-deployment`,
      stages: [
        {
          stageName: "Source",
          actions: [this.createSourceAction(sourceOutput, { ...props })],
        },
        {
          stageName: "Build",
          actions: [
            this.createDockerBuildAction(
              sourceOutput,
              dockerBuildOutput,
              pipelineRole,
              {
                repositoryUri: this.ecrRepo.repositoryUri,
                containerName: containerName,
              }
            ),
          ],
        },
        {
          stageName: "Deploy",
          actions: [
            this.createEcsDeployAction(
              dockerBuildOutput,
              pipelineRole,
              props.vpc_id,
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
    const key = kms.Key.fromKeyArn(
      this,
      `${props.project_code}-key-deployment`,
      cdk.Fn.importValue(`${this.project_code}-BucketKmsKeyArn`)
    );

    return s3.Bucket.fromBucketAttributes(this, "ArtifactBucket", {
      bucketName: props.artifact_bucket_name,
      encryptionKey: key,
    });
  }

  private createSourceAction(
    output: codepipeline.Artifact,
    props: {
      code_repo_name: string;
      code_repo_branch: string;
      code_repo_owner?: string;
      code_repo_secret_var?: string;
    }
  ): codepipeline_actions.GitHubSourceAction {
    const githubAction = new codepipeline_actions.GitHubSourceAction({
      actionName: "Github_Source",
      repo: props.code_repo_name,
      branch: props.code_repo_branch,
      owner: props.code_repo_owner!,
      oauthToken: cdk.SecretValue.secretsManager(props.code_repo_secret_var!),
      output: output,
    });
    return githubAction;
  }

  private createDockerBuildAction(
    input: codepipeline.Artifact,
    output: codepipeline.Artifact,
    role: iam.IRole,
    props: { repositoryUri: string; containerName: string },
    runOrder: number = 1
  ): codepipeline_actions.CodeBuildAction {
    const project = new codebuild.PipelineProject(this, "CodeBuildProject", {
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_3,
        privileged: true,
      },
      buildSpec: this.createBuildSpecFromFile("./buildspec.yml"),
      environmentVariables: {
        REPOSITORY_URI: { value: props.repositoryUri },
        CONTAINER_NAME: { value: props.containerName },
      },
    });
    // this.ecrRepo.grantPullPush(project.grantPrincipal);
    project.role?.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonEC2ContainerRegistryPowerUser"
      )
    );

    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: "DockerBuild_Action",
      project: project,
      input: input,
      outputs: [output],
      role: role,
      runOrder: runOrder,
    });

    return buildAction;
  }

  private createEcsDeployAction(
    input: codepipeline.Artifact,
    role: iam.IRole,
    vpcId: string,
    runOrder: number = 1,
    timeoutMinutes: number = 30
  ): codepipeline_actions.EcsDeployAction {
    const importedSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
      this,
      "imported-security-group",
      cdk.Fn.importValue(`${this.project_code}-FargateClusterSecurityGroupId`)
    );
    const vpc = ec2.Vpc.fromVpcAttributes(this, `${this.stackName}-vpc`, {
      vpcId: vpcId,
      availabilityZones: [
        "ap-southeast-1a",
        "ap-southeast-1b",
        "ap-southeast-1c",
      ],
    });

    const importedCluster = ecs.Cluster.fromClusterAttributes(
      this,
      "imported-fargate-cluster",
      {
        clusterName: cdk.Fn.importValue(
          `${this.project_code}-FargateClusterName`
        ),
        vpc: vpc,
        securityGroups: [],
      }
    );
    this.importedFargateService =
      ecs.FargateService.fromFargateServiceAttributes(
        this,
        "imported-fargate-service",
        {
          serviceName: cdk.Fn.importValue(
            `${this.project_code}-FargateServiceName`
          ),
          // Bug: reported at https://github.com/aws/aws-cdk/issues/16634
          // serviceArn: cdk.Fn.importValue(
          //   `${this.project_code}-FargateServiceArn`
          // ),
          cluster: importedCluster,
        }
      ) as ecs.FargateService;

    const ecsDeployAction = new codepipeline_actions.EcsDeployAction({
      actionName: "EcsDeploy_Action",
      input: input,
      /* Use imageFile if file name is not imagedefinitions.json */
      // imageFile: input.atPath("imageDef.json"),
      service: this.importedFargateService,
      // deploymentTimeout: cdk.Duration.minutes(timeoutMinutes),
      role: role,
      runOrder: runOrder,
    });
    return ecsDeployAction;
  }

  private createBuildSpecFromFile(filepath: string) {
    return codebuild.BuildSpec.fromSourceFilename(filepath);
  }

  private output() {
    new cdk.CfnOutput(this, "DeploymentPipelineName", {
      value: this.pipeline.pipelineName,
    });

    new cdk.CfnOutput(this, "importedFargateServiceName", {
      value: this.importedFargateService.serviceName,
    });

    new cdk.CfnOutput(this, "importedFargateServiceArn", {
      value: this.importedFargateService.serviceArn,
    });

    new cdk.CfnOutput(this, "importedFargateClusterName", {
      value: this.importedFargateService.cluster.clusterName,
    });

    new cdk.CfnOutput(this, "importedFargateClusterArn", {
      value: this.importedFargateService.cluster.clusterArn,
    });
  }
}
