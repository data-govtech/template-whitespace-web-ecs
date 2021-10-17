# Whitespace Web ECR

This project uses AWS CDK to deploy ReactJS website on Fargate Cluster. 

Tags: `aws-cdk`,`aws-fargate`, `aws-alb`, `aws-codepipeline`, `aws-ecr`, `reactjs`, `cicd` 

<img src="https://raw.githubusercontent.com/qinjie/picgo-images/main/image-20210913110731954.png" alt="image-20210913110731954" style="zoom:67%;" />

Reference:
https://blog.petrabarus.net/2020/03/23/building-ci-cd-pipeline-using-aws-codepipeline-aws-codebuild-amazon-ecr-amazon-ecs-with-aws-cdk/



## Roles



Note: If the CodeBuild fails at the login-AWS command in buildspec.yml, it usually indicates an unauthorized user. To fix this, we need to grant CodeBuild role be able to talk to ECR. To do this: Go to IAM and then attach a AmazonEC2ContainerRegistryPowerUser policy to your CodeBuild role.



## Test



### Test CodeBuild Locally

Reference: https://docs.aws.amazon.com/codebuild/latest/userguide/use-codebuild-agent.html

* Following above guide to setup build image in Docker. Use AWS Linux 2 image instead of Ubuntu.

  ```bash
  cd ./aws-codebuild-docker-images/al2/x86_64/standard/3.0
  docker build -t aws/codebuild/standard:3.0 .
  ```

* Download the `codebuild_build.sh` script to the same folder as `buildspec.yml`.

  ```bash
  wget https://raw.githubusercontent.com/aws/aws-codebuild-docker-images/master/local_builds/codebuild_build.sh
  chmod +x codebuild_build.sh
  ```

* Start Docker Desktop. Run following command,

  ```bash
  ./codebuild_build.sh -i aws/codebuild/standard:3.0 -a <output directory>
  ```

   

## Deployment



### Development

* Run `cdk list` to list all stacks.
* Run `cdk deploy <stack-name>` to deploy a stack. You can deploy `whitespace-app-ecr-.template.json` which will deploy both stacks at the same time.



### Production

* Run `cdk synth` to generate latest copy of `*.template.json` files.
* Commit code into GitHub.
* Upload `*.template.json` files to a temp S3 bucket.
* Deploy `whitespace-app-ecr-webapp.template.json` file in CloudFormation.
* Deploy `whitespace-app-ecr.template.json` file in CloudFormation.
