FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080 \
    NAS_ROOTS=/data \
    CONFIG_DIR=/config

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY web_app.py nas_renamer_service.py ./
COPY templates ./templates
COPY static ./static
COPY renamer ./renamer

RUN mkdir -p /data /config && chmod 755 /app

EXPOSE 8080
VOLUME ["/data", "/config"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=3)"

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "8", "--timeout", "300", "web_app:app"]

