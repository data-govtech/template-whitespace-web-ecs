# CDK Template - Deploy Web App using ECS

This project uses AWS CDK to deploy ReactJS website on Fargate Cluster. 

Tags: `aws-cdk`,`aws-fargate`, `aws-alb`, `aws-codepipeline`, `aws-ecr`, `reactjs`, `cicd` 

<img src="https://raw.githubusercontent.com/qinjie/picgo-images/main/image-20210913110731954.png" alt="image-20210913110731954" style="zoom:67%;" />

How to use this template project?
- Move web project into `frontend` folder and add some files from this template project.
- Copy CDK project (other than `frontend` folder) and update configurations in CDK project.

## How to use this template project?

### Setup Web Project

- In website project, create a new folder `frontend`; Move whole website project, excluding `.git` folder, into it. 
- From template project, copy following files/folders into `frontend` folder: `nginx/`, `.dockerignore`, `Dockerfile`.
- Update `frontend/Dockerfile` accordingly, which builds website into a Docker image.

#### Test in Local Server

In the project directory, you can run:

- `yarn install` install packages
- `yarn run build` build static files for deployment
- `yarn start ` start project


#### Test using Docker

The `Dockerfile` is provided in project directory to build the project into a docker image. 

* Build docker image.
  ```bash
  docker build -t "my-template" .
  ```
* Run the image in a container. 
  ```bash
  docker run -p 8080:80 --name my_container my-template
  ```
* Test the site at [http://localhost:8080/](

### Copy CDK Project

- From template project, copy all except following folders into website project folder.
    * `.git`, `cdk.out`, `frontend`, `node_modules`
- In ewbsite project folder, edit `package.json` file.
    * Update project name `"name": "PROJECT-NAME-HERE"`
- Update `.env` file accordingly
    * Especially `PROJECT_CODE`, `CODE_REPO_NAME`, `CODE_REPO_BRANCH`, and other AWS environment related settings

### Run CDK Project
- Run `npm install` to install libraries
- Run `cdk synth --profile capdev` to generate CloudFormation template files

## Deploy to CloudFormation

### Deployment by CDK CLI

* Run `npm install` to install required libraries.
* Run `cdk list` to list all stacks.
* Run `cdk deploy <stack-name>` to deploy a stack. You can deploy `whitespace-app-ecr-.template.json` which will deploy both stacks at the same time.


### Deployment by CloudFormation

* Run `npm install` to install required libraries.
* Run `cdk synth` to generate latest copy of `*.template.json` files. You are not using default AWS profile, specify the profile to use in the command, e.g. `cdksynth --profile capdev`.
* Deploy `cdk.out\project-pidove.template.json` file in CloudFormation.


