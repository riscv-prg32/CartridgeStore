FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PRG32_STORE_DATA=/data
ENV PRG32_STORE_DB=/data/cartrige_store.sqlite

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN adduser --disabled-password --gecos "" --home /app prg32 \
    && mkdir -p /data \
    && chown -R prg32:prg32 /app /data

USER prg32

EXPOSE 5080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5080/.well-known/prg32-store.json', timeout=3).read()"

CMD ["gunicorn", "--bind", "0.0.0.0:5080", "--threads", "8", "--timeout", "120", "app:app"]
