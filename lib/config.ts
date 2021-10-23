// Load .env file and construct tags
require("dotenv").config();
const project_code = process.env.PROJECT_CODE;

export const CONTAINER_NAME = `${project_code}-ContainerName`;
