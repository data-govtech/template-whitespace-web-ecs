import * as cdk from "@aws-cdk/core";
import { DockerImageAsset } from "@aws-cdk/aws-ecr-assets";
import * as path from "path";
import * as ecrdeploy from "cdk-ecr-deployment";
import * as ecr from "@aws-cdk/aws-ecr";
import * as codepipeline from "@aws-cdk/aws-codepipeline";

export interface EcrStackProps extends cdk.StackProps {
  ecr_repo_name: string;
  ecr_repo_version: string;
  ecr_repo_uri: string;
}

export class EcrStack extends cdk.Stack {
  public artifact_path: codepipeline.ArtifactPath;

  constructor(scope: cdk.Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);

    /* Try to create the ECR repository */
    let ecrRepo: ecr.IRepository;
    try {
      ecrRepo = new ecr.Repository(this, "EcrRepo", {
        repositoryName: props.ecr_repo_name,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    } catch (e) {
      ecrRepo = ecr.Repository.fromRepositoryName(
        scope,
        "EcrREpo",
        props.ecr_repo_name
      );
    }

    const dockerImage = new DockerImageAsset(this, `CreateDockerImage`, {
      directory: path.join("./frontend"),
    });

    new ecrdeploy.ECRDeployment(this, "DeployDockerImage-tagged", {
      src: new ecrdeploy.DockerImageName(dockerImage.imageUri),
      dest: new ecrdeploy.DockerImageName(
        `${ecrRepo.repositoryUri}:${dockerImage.assetHash}`
      ),
    });

    new ecrdeploy.ECRDeployment(this, "DeployDockerImage-latest", {
      src: new ecrdeploy.DockerImageName(dockerImage.imageUri),
      dest: new ecrdeploy.DockerImageName(`${ecrRepo.repositoryUri}:latest`),
    });
  }
}
