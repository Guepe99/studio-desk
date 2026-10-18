FROM python:3.12-slim-bookworm
WORKDIR /app
COPY pyproject.toml ./
COPY studiodesk ./studiodesk
RUN pip install --no-cache-dir -e . && useradd -u 10001 app
COPY web ./web
COPY data/forbidden_names.txt ./data/
# The demo matches are rebuilt from the seed at image build: no data files in git.
RUN python -m studiodesk.sim build --matches 4 --seed 7 \
 && python -m studiodesk.facts build --all \
 && for m in M001 M002 M003 M004; do python -m studiodesk.export "$m"; done \
 && chown -R app /app/data
USER app
EXPOSE 8000
CMD ["uvicorn", "studiodesk.api:app", "--host", "0.0.0.0", "--port", "8000"]
