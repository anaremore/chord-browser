# Security headers for every response (nginx.conf). The page loads nothing from
# elsewhere but GitHub's API, for the download links.
add_header Content-Security-Policy "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src https://api.github.com; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), browsing-topics=()" always;
add_header Strict-Transport-Security "max-age=31536000" always;
