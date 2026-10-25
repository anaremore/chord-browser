# chordbrowser.com on Clank (site/README.md). Built from the repo's root:
# its Dockerfile path is site/Dockerfile, and Dockerfile.dockerignore beside it
# keeps the build context to site/.
FROM nginxinc/nginx-unprivileged:1.29-alpine

COPY site/nginx.conf /etc/nginx/conf.d/default.conf
COPY site/headers.inc /etc/nginx/headers.inc
COPY site/downloads.conf /etc/nginx/downloads.conf
COPY site/public/ /usr/share/nginx/html/

EXPOSE 8080
