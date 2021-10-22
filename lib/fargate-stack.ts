import * as cdk from "@aws-cdk/core";
import * as ecs from "@aws-cdk/aws-ecs";
import * as ecsPatterns from "@aws-cdk/aws-ecs-patterns";
import * as ecr from "@aws-cdk/aws-ecr";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as iam from "@aws-cdk/aws-iam";
import { IRole } from "@aws-cdk/aws-iam";

export interface FargateStackProps extends cdk.StackProps {
  readonly project_code: string;
  // readonly container_image?: ecs.ContainerImage;
  readonly vpc_id: string;
  readonly public_subnet_ids: string[];
  readonly public_route_table_id: string;
  readonly private_subnet_ids: string[];
  readonly private_route_table_id: string;
  // domain
  readonly domain_name?: string;
  readonly hosted_zone_name?: string;
  readonly hosted_zone_id?: string;
  readonly certificate_arn?: string;
}

export class FargateStack extends cdk.Stack {
  public readonly project_code: string;
  public readonly ecsCluster: ecs.Cluster;
  // public readonly fargateService: ecs.FargateService;
  public readonly fargateTask: ecs.FargateTaskDefinition;

  public readonly ecrRepo: ecr.IRepository;
  public readonly vpc: ec2.IVpc;
  public readonly public_subnets: ec2.ISubnet[];
  public readonly private_subnets: ec2.ISubnet[];

  // public readonly fargateSecurityGroup: ec2.SecurityGroup;

  constructor(scope: cdk.Construct, id: string, props: FargateStackProps) {
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

    this.ecsCluster = new ecs.Cluster(this, "EcsCluster", {
      vpc: this.vpc,
      clusterName: `${props.project_code}-cluster`,
    });

    /* Container Task Role */
    const containerTaskRole = this.createContainerTaskRole(
      `${props.project_code}-task-role`
    );

    /* Agent Execution Role */
    const agentExecutionRole = this.createAgentExecutionRole(
      `${props.project_code}-execution-role`
    );

    /* Get existing ECR Repo */
    this.ecrRepo = ecr.Repository.fromRepositoryName(
      this,
      `${this.stackName}-EcrREpo`,
      cdk.Fn.importValue(`${this.project_code}-EcrRepositoryName`)
    );

    this.fargateTask = this.createFargateTask(
      containerTaskRole,
      agentExecutionRole,
      this.ecrRepo,
      `${props.project_code}`
    );

    /* Grant agentExecutionRole rights to access ecrRepo */
    this.ecrRepo.grantPull(agentExecutionRole.grantPrincipal);

    // /* ECS Cluster and Service used to deploy ECS Task */
    // // Security group to allow connections from the ALB to fargate containers
    // this.fargateSecurityGroup = new ec2.SecurityGroup(
    //   this,
    //   "ecs-security-group",
    //   { vpc: this.vpc, allowAllOutbound: true }
    // );

    // this.fargateService = new ecs.FargateService(this, "fargate-service", {
    //   cluster: this.ecsCluster,
    //   desiredCount: 1,
    //   taskDefinition: this.fargateTask,
    //   securityGroups: [this.fargateSecurityGroup],
    //   assignPublicIp: true,
    //   vpcSubnets: { subnets: this.private_subnets },
    //   platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
    // });

    // // Add autoscaling to fargate cluster
    // this.addAutoScaleFargateService();

    // // Add ALB to fargate cluster
    // this.addAlbToFargateService({
    //   domain_name: props.domain_name!,
    //   hosted_zone_name: props.hosted_zone_name!,
    //   hosted_zone_id: props.hosted_zone_id!,
    //   certificate_arn: props.certificate_arn!,
    // });

    this.output();
  }

  private createContainerTaskRole(roleName: string) {
    const containerTaskRole = new iam.Role(this, `task-role`, {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      roleName: roleName,
    });
    const managedPolicies = [
      "AmazonDynamoDBFullAccess",
      "AmazonSQSFullAccess",
      "AmazonSESFullAccess",
      "AmazonS3FullAccess",
    ];
    managedPolicies.forEach((policy) => {
      containerTaskRole.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName(policy)
      );
    });
    return containerTaskRole;
  }

  private createAgentExecutionRole(roleName: string) {
    const agentExecutionRole = new iam.Role(this, `execution-role`, {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      roleName: roleName,
    });
    agentExecutionRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
        ],
        resources: [`*`],
      })
    );
    return agentExecutionRole;
  }

  /* Not working, fromRepositoryName doesn't flag problem if repo not exists 
    Pending https://github.com/aws/aws-cdk/issues/8461
  */
  private getOrCreateEcrRepo(
    stack: cdk.Stack,
    ecr_repo_name: string
  ): ecr.IRepository {
    //Try to get existing the ECR repository
    let ecrRepo: ecr.IRepository;
    ecrRepo = ecr.Repository.fromRepositoryName(
      stack,
      `${stack.stackName}-EcrREpo`,
      ecr_repo_name
    );
    console.log(ecrRepo.repositoryUri);

    // If not found, create a new ecr Repository
    if (!ecrRepo.repositoryUri) {
      ecrRepo = new ecr.Repository(stack, `${stack.stackName}-EcrREpo`, {
        repositoryName: ecr_repo_name,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }

    return ecrRepo;
  }

  private createFargateTask(
    containerTaskRole: IRole,
    agentExecutionRole: IRole,
    ecrRepo: ecr.IRepository,
    project_code: string
  ) {
    const fargateTask = new ecs.FargateTaskDefinition(this, "FargateTask", {
      cpu: 256,
      taskRole: containerTaskRole,
      executionRole: agentExecutionRole,
      family: `${project_code}-fargate-task`,
      memoryLimitMiB: 1024,
    });

    // Add container with specific container image from ECR
    const container = fargateTask.addContainer("container", {
      // image: ecs.RepositoryImage.fromAsset(
      //   path.join(__dirname, "..", props.src_path)
      // ),
      image: ecs.RepositoryImage.fromEcrRepository(ecrRepo, "latest"),
      memoryLimitMiB: 512,
      environment: {
        API_HOST: "",
        DB_HOST: "",
      },
      // store logs in cloudwatch
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: `${project_code}-fargate-logs`,
      }),
    });

    // Add port mapping
    container.addPortMappings({ containerPort: 80 });

    return fargateTask;
  }

  private createEcsPatternFargateService(
    cluster: ecs.ICluster,
    assetPath: string,
    vpc: ec2.IVpc,
    subnets: ec2.ISubnet[],
    containerName: string
  ) {
    return new ecsPatterns.ApplicationLoadBalancedFargateService(
      this,
      "FargateService",
      {
        cluster: cluster,
        taskImageOptions: {
          // image: ecs.ContainerImage.fromAsset(assetPath),
          image: this.ecrRepo
            ? ecs.ContainerImage.fromEcrRepository(this.ecrRepo)
            : ecs.ContainerImage.fromAsset(assetPath),
          containerName: containerName,
        },
        vpc: vpc,
        taskSubnets: { subnets: subnets },
        publicLoadBalancer: true,
      }
    );
  }

  // private addAutoScaleFargateService() {
  //   // Autoscaling based on memory and CPU usage
  //   const scalableTarget = this.fargateService.autoScaleTaskCount({
  //     minCapacity: 1,
  //     maxCapacity: 10,
  //   });

  //   scalableTarget.scaleOnMemoryUtilization("ScaleUpMem", {
  //     targetUtilizationPercent: 75,
  //     scaleInCooldown: cdk.Duration.seconds(60),
  //     scaleOutCooldown: cdk.Duration.seconds(60),
  //   });

  //   scalableTarget.scaleOnCpuUtilization("ScaleUpCPU", {
  //     targetUtilizationPercent: 75,
  //     scaleInCooldown: cdk.Duration.seconds(60),
  //     scaleOutCooldown: cdk.Duration.seconds(60),
  //   });
  // }

  // private addAlbToFargateService(props: {
  //   hosted_zone_name: string;
  //   hosted_zone_id: string;
  //   domain_name: string;
  //   certificate_arn: string;
  // }) {
  //   // /* ####################################### */
  //   // /* Define TargetGroup, ALB, Listener       */

  //   const alb = new elb.ApplicationLoadBalancer(this, "alb", {
  //     vpc: this.vpc,
  //     internetFacing: true,
  //     vpcSubnets: { subnets: this.public_subnets },
  //   });

  //   const targetGroup = new elb.ApplicationTargetGroup(
  //     this,
  //     "target-group-http",
  //     {
  //       port: 80,
  //       vpc: this.vpc,
  //       protocol: elb.ApplicationProtocol.HTTP,
  //       targetType: elb.TargetType.IP,
  //     }
  //   );

  //   targetGroup.configureHealthCheck({
  //     path: "/",
  //     protocol: elb.Protocol.HTTP,
  //   });

  //   this.fargateService.attachToApplicationTargetGroup(targetGroup);

  //   let zone = route53.PublicHostedZone.fromHostedZoneAttributes(
  //     this,
  //     "hosted-zone",
  //     {
  //       zoneName: props.hosted_zone_name!,
  //       hostedZoneId: props.hosted_zone_id!,
  //     }
  //   );

  //   let listener: elb.ApplicationListener;

  //   if (props.domain_name) {
  //     /* Works when domain is owned by the account */
  //     // const certificate = new cert_manager.DnsValidatedCertificate(
  //     //   this,
  //     //   "certificate",
  //     //   {
  //     //     domainName: props.domain_name,
  //     //     hostedZone: zone,
  //     //     region: "ap-southeast-1",
  //     //   }
  //     // );

  //     /* Works when domain is owned by another account */
  //     const certificate = cert_manager.Certificate.fromCertificateArn(
  //       this,
  //       "certificateImported",
  //       props.certificate_arn
  //     );

  //     listener = alb.addListener("alb-listener", {
  //       open: true,
  //       port: 443,
  //       certificates: [certificate],
  //     });
  //   } else {
  //     listener = alb.addListener("alb-listener", {
  //       open: true,
  //       port: 80,
  //     });
  //   }

  //   listener.addTargetGroups("alb-listener-target-group", {
  //     targetGroups: [targetGroup],
  //   });

  //   // Enable a redirect from port 80 to 443
  //   alb.addRedirect();

  //   /* Add security group to ALB */
  //   const alb_sg = new ec2.SecurityGroup(this, "alb-security-group", {
  //     vpc: this.vpc,
  //     allowAllOutbound: true,
  //   });

  //   alb_sg.addIngressRule(
  //     ec2.Peer.anyIpv4(),
  //     ec2.Port.tcp(443),
  //     "Allow https traffic"
  //   );
  //   alb.addSecurityGroup(alb_sg);

  //   // Set Fargate allow connections from alb
  //   this.fargateSecurityGroup.connections.allowFrom(
  //     alb_sg,
  //     ec2.Port.allTcp(),
  //     "ALB to Fargate"
  //   );

  //   /* ####################################### */
  //   /* Route53 A Record                        */
  //   if (props.domain_name) {
  //     const arecord = new route53.ARecord(this, "AliasRecrod", {
  //       zone,
  //       recordName: props.domain_name,
  //       target: route53.RecordTarget.fromAlias(
  //         new route53_target.LoadBalancerTarget(alb)
  //       ),
  //     });
  //     arecord.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  //   }
  // }

  private output() {
    // new cdk.CfnOutput(this, "fargate-cluster-security-group-id", {
    //   value: this.fargateSecurityGroup.securityGroupId,
    //   exportName: `${this.project_code}-FargateClusterSecurityGroupId`,
    //   description: "ID of Security Group used by Fargate Cluster",
    // });

    new cdk.CfnOutput(this, "FargateClusterVpcId", {
      value: this.vpc.vpcId,
      exportName: `${this.project_code}-FargateClusterVpcId`,
      description: "ID of VPC used by Fargate Cluster",
    });

    new cdk.CfnOutput(this, "FargateClusterContainerName", {
      value: this.fargateTask.defaultContainer!.containerName,
      exportName: `${this.project_code}-FargateClusterContainerName`,
    });

    new cdk.CfnOutput(this, "FargateTaskDefinitionArn", {
      value: this.fargateTask.taskDefinitionArn,
      exportName: `${this.project_code}-FargateTaskDefinitionArn`,
    });

    new cdk.CfnOutput(this, "FargateClusterArn", {
      value: this.ecsCluster.clusterArn,
      exportName: `${this.project_code}-FargateClusterArn`,
      description: "ARN of Cluster used in Fargate Service",
    });

    new cdk.CfnOutput(this, "FargateClusterName", {
      value: this.ecsCluster.clusterName,
      exportName: `${this.project_code}-FargateClusterName`,
      description: "Name of Cluster used in Fargate Service",
    });

    // new cdk.CfnOutput(this, "FargateServiceName", {
    //   value: this.fargateService.serviceName,
    //   exportName: `${this.project_code}-FargateServiceName`,
    // });

    // new cdk.CfnOutput(this, "FargateServiceArn", {
    //   value: this.fargateService.serviceArn,
    //   exportName: `${this.project_code}-FargateServiceArn`,
    //   description: "ARN of Fargate Service",
    // });
  }
}
