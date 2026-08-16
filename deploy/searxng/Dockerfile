# SearXNG image for the discover pipeline. secret_key baked at build (CSRF
# only; API is IAM-gated). Brave key injected at boot so no secret in image.
FROM searxng/searxng:latest

COPY settings.yml /etc/searxng/settings.yml
COPY entrypoint.sh /usr/local/bin/cp-searxng-entrypoint.sh

USER root
RUN sed -i "s|__SECRET_KEY__|$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')|" /etc/searxng/settings.yml \
    && chmod +x /usr/local/bin/cp-searxng-entrypoint.sh
USER searxng

ENTRYPOINT ["/usr/local/bin/cp-searxng-entrypoint.sh"]
