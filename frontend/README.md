# Project Template - Web Client

This project provides a template ReactJS(TypeScript) project deployable using Docker. 

## Available Scripts

### Test in Local Server

In the project directory, you can run:

- `yarn install` install packages
- `yarn run build` build static files for deployment
- `yarn start ` start project


### Test using Docker

The `Dockerfile` is provided in project directory to build the project into a docker image. 

* Build docker image.

  ```bash
  docker build -t "pidove" .
  ```

* Run the image in a container. 

  ```bash
  docker run -p 8080:80 --name pidove_container pidove
  ```

* Test the site at [http://localhost:8080/](http://localhost:8080/)
