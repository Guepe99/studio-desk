FROM python:3.12-slim-bookworm
WORKDIR /app
COPY pyproject.toml ./
# Dependencies first, in their own layer: a code change does not reinstall them.
# Editable: config.py and api.py find data/ and web/ next to the package, under /app.
RUN mkdir studiodesk && touch studiodesk/__init__.py && pip install --no-cache-dir -e . && useradd -u 10001 app
COPY studiodesk ./studiodesk
COPY web ./web
RUN gzip -k -9 web/vendor/babylonjs/*/*.js
COPY data/forbidden_names.txt ./data/
# What cannot be rebuilt without Azure (AI packs, voice clips) is committed in replays/<match>/.
COPY replays ./replays
# The demo matches are rebuilt from the seed at image build: no data files in git. Then each
# replays/<match>/ is laid over its export, so a committed pack replaces the template files.
RUN set -e; python -m studiodesk.sim build --matches 4 --seed 7 \
 && python -m studiodesk.facts build --all \
 && for m in M001 M002 M003 M004; do python -m studiodesk.export "$m" && gzip -k -6 "web/data/$m/tracking.f32"; done \
 && for d in replays/*/; do m=$(basename "$d"); mkdir -p "web/data/$m" && cp -r "$d". "web/data/$m/"; done \
 && chown -R app /app/data
USER app
EXPOSE 8000
CMD ["uvicorn", "studiodesk.api:app", "--host", "0.0.0.0", "--port", "8000"]
