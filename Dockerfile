FROM python:3.12-slim-bookworm
WORKDIR /app
COPY pyproject.toml ./
COPY studiodesk ./studiodesk
RUN pip install --no-cache-dir -e . && useradd -u 10001 app
COPY web ./web
COPY data/forbidden_names.txt ./data/
USER app
EXPOSE 8000
CMD ["uvicorn", "studiodesk.api:app", "--host", "0.0.0.0", "--port", "8000"]
