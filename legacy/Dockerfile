FROM caddy:2.7-alpine

# Copy the web application files
COPY index.html /srv/
COPY styles.css /srv/
COPY script.js /srv/
COPY README.md /srv/

# Copy Caddyfile configuration
COPY Caddyfile /etc/caddy/Caddyfile

# Expose port 80
EXPOSE 80

# Start Caddy
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]