# Valfritt: frontend kan lika gärna läggas upp som statiska filer (t.ex. people.arcada.fi).
# nginx-unprivileged kör som icke-root och lyssnar på 8080, vilket funkar på CSC Rahti.
FROM nginxinc/nginx-unprivileged:alpine
COPY --chown=nginx:root . /usr/share/nginx/html
EXPOSE 8080
