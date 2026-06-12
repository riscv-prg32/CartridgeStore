FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PRG32_STORE_DATA=/data
ENV PRG32_STORE_DB=/data/cartridge_store.sqlite


# Default UID/GID used inside the container.
# Override them at build time to match your host user:
# docker build --build-arg APP_UID=$(id -u) --build-arg APP_GID=$(id -g) -t my-image .
ARG APP_UID=1000
ARG APP_GID=1000

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

#RUN adduser --giud 3050 --disabled-password --gecos "" --home /app prg32 \
#    && mkdir -p /data \
#    && chown -R prg32:prg32 /app /data

RUN groupadd --gid ${APP_GID} prg32 \
    && useradd --uid ${APP_UID} \
        --gid ${APP_GID} \
        --create-home \
        --home-dir /app \
        --shell /bin/bash \
        prg32 \
    && mkdir -p /data \
    && chown -R prg32:prg32 /app /data


USER prg32

EXPOSE 5080

#HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
#    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5080/.well-known/prg32-store.json', timeout=3).read()"

CMD ["gunicorn", "--bind", "0.0.0.0:5080", "--threads", "8", "--timeout", "120", "app:app"]
