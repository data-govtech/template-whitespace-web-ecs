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
import { FargateTaskDefinition } from "@aws-cdk/aws-ecs";
import * as elb from "@aws-cdk/aws-elasticloadbalancingv2";
import * as route53 from "@aws-cdk/aws-route53";
import * as route53_target from "@aws-cdk/aws-route53-targets";
import * as cert_manager from "@aws-cdk/aws-certificatemanager";

export interface DeploymentStackProps extends cdk.StackProps {
  // basic props
  readonly project_code: string;
  // readonly container_image?: ecs.ContainerImage;
  readonly vpc_id: string;
  readonly public_subnet_ids: string[];
  readonly public_route_table_id: string;
  readonly private_subnet_ids: string[];
  readonly private_route_table_id: string;

  readonly codepipeline_role_arn?: string;
  readonly cloudformation_role_arn: string;
  readonly artifact_bucket_name: string;
  // repo
  readonly code_repo_name: string;
  readonly code_repo_branch: string;
  readonly code_repo_secret_var?: string;
  readonly code_repo_owner?: string;
  // domain
  readonly domain_name?: string;
  readonly hosted_zone_name?: string;
  readonly hosted_zone_id?: string;
  readonly certificate_arn?: string;
}

export class DeploymentStack extends cdk.Stack {
  public readonly pipeline: codepipeline.Pipeline;
  public readonly ecrRepo: ecr.IRepository;
  // public importedFargateService: ecs.FargateService;
  public readonly fargateService: ecs.FargateService;
  readonly project_code: string;
  public readonly fargateSecurityGroup: ec2.SecurityGroup;
  public readonly vpc: ec2.IVpc;
  readonly public_subnets: ec2.ISubnet[];
  readonly private_subnets: ec2.ISubnet[];

  public readonly containerName: string;
  public readonly ecsCluster: ecs.ICluster;
  public readonly fargateTask: ecs.IFargateTaskDefinition;

  constructor(scope: cdk.Construct, id: string, props: DeploymentStackProps) {
    super(scope, id, props);

    this.project_code = props.project_code;

    /* Import existing VPC, get default VPC if name is undefined*/
    this.vpc = ec2.Vpc.fromLookup(this, "vpc", {
      vpcId: props.vpc_id,
    });
    const routeTableIdPublic = props.public_route_table_id;
    this.public_subnets = props.public_subnet_ids
      ? props.public_subnet_ids.map((subnetId) =>
          ec2.Subnet.fromSubnetAttributes(this, subnetId, {
            subnetId,
            routeTableId: routeTableIdPublic,
          })
        )
      : this.vpc.publicSubnets;

    const routeTableIdPrivate = props.private_route_table_id;
    this.private_subnets = props.private_subnet_ids
      ? props.private_subnet_ids.map((subnetId) =>
          ec2.Subnet.fromSubnetAttributes(this, subnetId, {
            subnetId,
            routeTableId: routeTableIdPrivate,
          })
        )
      : this.vpc.privateSubnets;

    this.containerName = cdk.Fn.importValue(
      `${this.project_code}-FargateClusterContainerName`
    );

    /* Get existing ECR Repo */
    this.ecrRepo = ecr.Repository.fromRepositoryName(
      this,
      `${this.stackName}-EcrREpo`,
      cdk.Fn.importValue(`${this.project_code}-EcrRepositoryName`)
    );

    /* ECS Cluster and Service used to deploy ECS Task */
    // Security group to allow connections from the ALB to fargate containers
    this.fargateSecurityGroup = new ec2.SecurityGroup(
      this,
      "ecs-security-group",
      { vpc: this.vpc, allowAllOutbound: true }
    );

    this.ecsCluster = ecs.Cluster.fromClusterAttributes(
      this,
      `${this.stackName}-EcsCluster`,
      {
        clusterName: cdk.Fn.importValue(
          `${this.project_code}-FargateClusterName`
        ),
        securityGroups: [this.fargateSecurityGroup],
        vpc: this.vpc,
      }
    );

    this.fargateTask = ecs.FargateTaskDefinition.fromFargateTaskDefinitionArn(
      this,
      `${this.stackName}-FargateTaskDefinition`,
      cdk.Fn.importValue(`${this.project_code}-FargateTaskDefinitionArn`)
    );

    this.fargateService = new ecs.FargateService(this, "fargate-service", {
      cluster: this.ecsCluster,
      desiredCount: 1,
      taskDefinition: this.fargateTask as FargateTaskDefinition,
      securityGroups: [this.fargateSecurityGroup],
      assignPublicIp: true,
      vpcSubnets: { subnets: this.private_subnets },
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
    });

    // Add autoscaling to fargate cluster
    this.addAutoScaleFargateService();

    // Add ALB to fargate cluster
    this.addAlbToFargateService({
      domain_name: props.domain_name!,
      hosted_zone_name: props.hosted_zone_name!,
      hosted_zone_id: props.hosted_zone_id!,
      certificate_arn: props.certificate_arn!,
    });

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
          stageName: "BuildContainer",
          actions: [
            this.createDockerBuildAction(
              sourceOutput,
              dockerBuildOutput,
              pipelineRole,
              {
                repositoryUri: this.ecrRepo.repositoryUri,
                containerName: this.containerName,
              }
            ),
          ],
        },
        {
          stageName: "DeployECS",
          actions: [
            this.createEcsDeployAction(
              dockerBuildOutput,
              pipelineRole,
              props.vpc_id
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
    // const importedSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(
    //   this,
    //   "imported-security-group",
    //   cdk.Fn.importValue(`${this.project_code}-FargateClusterSecurityGroupId`)
    // );
    // const vpc = ec2.Vpc.fromVpcAttributes(this, `${this.stackName}-vpc`, {
    //   vpcId: vpcId,
    //   availabilityZones: [
    //     "ap-southeast-1a",
    //     "ap-southeast-1b",
    //     "ap-southeast-1c",
    //   ],
    // });

    // const importedCluster = ecs.Cluster.fromClusterAttributes(
    //   this,
    //   "imported-fargate-cluster",
    //   {
    //     clusterName: cdk.Fn.importValue(
    //       `${this.project_code}-FargateClusterName`
    //     ),
    //     vpc: vpc,
    //     securityGroups: [],
    //   }
    // );

    // this.importedFargateService =
    //   ecs.FargateService.fromFargateServiceAttributes(
    //     this,
    //     "imported-fargate-service",
    //     {
    //       serviceName: cdk.Fn.importValue(
    //         `${this.project_code}-FargateServiceName`
    //       ),
    //       // Bug: reported at https://github.com/aws/aws-cdk/issues/16634
    //       // serviceArn: cdk.Fn.importValue(
    //       //   `${this.project_code}-FargateServiceArn`
    //       // ),
    //       cluster: importedCluster,
    //     }
    //   ) as ecs.FargateService;

    const ecsDeployAction = new codepipeline_actions.EcsDeployAction({
      actionName: "EcsDeploy_Action",
      input: input,
      /* Use imageFile if file name is not imagedefinitions.json */
      // imageFile: input.atPath("imageDef.json"),
      service: this.fargateService,
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
      value: this.fargateService.serviceName,
    });

    new cdk.CfnOutput(this, "importedFargateServiceArn", {
      value: this.fargateService.serviceArn,
    });

    new cdk.CfnOutput(this, "importedFargateClusterName", {
      value: this.fargateService.cluster.clusterName,
    });

    new cdk.CfnOutput(this, "importedFargateClusterArn", {
      value: this.fargateService.cluster.clusterArn,
    });
  }

  private addAutoScaleFargateService() {
    // Autoscaling based on memory and CPU usage
    const scalableTarget = this.fargateService.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 10,
    });

    scalableTarget.scaleOnMemoryUtilization("ScaleUpMem", {
      targetUtilizationPercent: 75,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    scalableTarget.scaleOnCpuUtilization("ScaleUpCPU", {
      targetUtilizationPercent: 75,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });
  }

  private addAlbToFargateService(props: {
    hosted_zone_name: string;
    hosted_zone_id: string;
    domain_name: string;
    certificate_arn: string;
  }) {
    // /* ####################################### */
    // /* Define TargetGroup, ALB, Listener       */

    const alb = new elb.ApplicationLoadBalancer(this, "alb", {
      vpc: this.vpc,
      internetFacing: true,
      vpcSubnets: { subnets: this.public_subnets },
    });

    const targetGroup = new elb.ApplicationTargetGroup(
      this,
      "target-group-http",
      {
        port: 80,
        vpc: this.vpc,
        protocol: elb.ApplicationProtocol.HTTP,
        targetType: elb.TargetType.IP,
      }
    );

    targetGroup.configureHealthCheck({
      path: "/",
      protocol: elb.Protocol.HTTP,
    });

    this.fargateService.attachToApplicationTargetGroup(targetGroup);

    let zone = route53.PublicHostedZone.fromHostedZoneAttributes(
      this,
      "hosted-zone",
      {
        zoneName: props.hosted_zone_name!,
        hostedZoneId: props.hosted_zone_id!,
      }
    );

    let listener: elb.ApplicationListener;

    if (props.domain_name) {
      /* Works when domain is owned by the account */
      // const certificate = new cert_manager.DnsValidatedCertificate(
      //   this,
      //   "certificate",
      //   {
      //     domainName: props.domain_name,
      //     hostedZone: zone,
      //     region: "ap-southeast-1",
      //   }
      // );

      /* Works when domain is owned by another account */
      const certificate = cert_manager.Certificate.fromCertificateArn(
        this,
        "certificateImported",
        props.certificate_arn
      );

      listener = alb.addListener("alb-listener", {
        open: true,
        port: 443,
        certificates: [certificate],
      });
    } else {
      listener = alb.addListener("alb-listener", {
        open: true,
        port: 80,
      });
    }

    listener.addTargetGroups("alb-listener-target-group", {
      targetGroups: [targetGroup],
    });

    // Enable a redirect from port 80 to 443
    alb.addRedirect();

    /* Add security group to ALB */
    const alb_sg = new ec2.SecurityGroup(this, "alb-security-group", {
      vpc: this.vpc,
      allowAllOutbound: true,
    });

    alb_sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "Allow https traffic"
    );
    alb.addSecurityGroup(alb_sg);

    // Set Fargate allow connections from alb
    this.fargateSecurityGroup.connections.allowFrom(
      alb_sg,
      ec2.Port.allTcp(),
      "ALB to Fargate"
    );

    /* ####################################### */
    /* Route53 A Record                        */
    if (props.domain_name) {
      const arecord = new route53.ARecord(this, "AliasRecrod", {
        zone,
        recordName: props.domain_name,
        target: route53.RecordTarget.fromAlias(
          new route53_target.LoadBalancerTarget(alb)
        ),
      });
      arecord.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
    }
  }
}
