# Base pinned by digest (python:3.12.15-slim-bookworm, index digest of 2026-10-06): a rebuild of the
# same commit gets the same system packages. To update: docker buildx imagetools inspect <tag>.
FROM python:3.12.15-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258
WORKDIR /app
COPY pyproject.toml ./
# Dependencies first, in their own layer: a code change does not reinstall them.
# Editable: config.py and api.py find data/ and web/ next to the package, under /app.
RUN mkdir studiodesk && touch studiodesk/__init__.py && pip install --no-cache-dir -e ".[agents]" && useradd -u 10001 app
COPY studiodesk ./studiodesk
COPY data/forbidden_names.txt ./data/
# The demo matches are rebuilt from the seed at image build: no data files in git. This slow layer
# depends only on the Python package, so a change to web/ or replays/ does not redo it.
RUN set -e; python -m studiodesk.sim build --matches 4 --seed 7 \
 && python -m studiodesk.facts build --all \
 && for m in M001 M002 M003 M004; do python -m studiodesk.export "$m" && gzip -k -6 "web/data/$m/tracking.f32"; done \
 && chown -R app /app/data
COPY web ./web
RUN gzip -k -9 web/vendor/babylonjs/*/*.js
# What cannot be rebuilt without Azure (AI packs, voice clips) is committed in replays/<match>/ and
# laid over each export, so a committed pack replaces the template files. Bind-mounted: the packs
# ship once, in web/data, with no copy left in /app/replays.
RUN --mount=type=bind,source=replays,target=/tmp/replays \
    set -e; for d in /tmp/replays/*/; do m=$(basename "$d"); mkdir -p "web/data/$m" && cp -r "$d". "web/data/$m/"; done
USER app
EXPOSE 8000
CMD ["uvicorn", "studiodesk.api:app", "--host", "0.0.0.0", "--port", "8000"]
