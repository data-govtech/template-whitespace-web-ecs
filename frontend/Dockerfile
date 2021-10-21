# stage1 - build react app first 
FROM node:12.16.1-alpine3.9 as build
# FROM 305326993135.dkr.ecr.ap-southeast-1.amazonaws.com/node:12.16.1-alpine3.9 as build
WORKDIR /app
ENV PATH /app/node_modules/.bin:$PATH
COPY ./package.json ./
COPY ./package-lock.json ./
RUN npm install --silent
COPY . ./
RUN npm run build

# stage 2 - build the final image and copy the react build files
FROM nginx:1.17.8-alpine
# FROM 305326993135.dkr.ecr.ap-southeast-1.amazonaws.com/nginx:1.17.8-alpine
COPY --from=build /app/build /usr/share/nginx/html
RUN rm /etc/nginx/conf.d/default.conf
COPY nginx/nginx.conf /etc/nginx/conf.d
EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
