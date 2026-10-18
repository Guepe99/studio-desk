# Third-party material

| What | Licence | Source | How we use it |
|---|---|---|---|
| socceraction (SPADL format, xT grid method) | MIT | https://github.com/ML-KULeuven/socceraction | Offline calibration script only; not shipped in the runtime |
| Wyscout public event data: L. Pappalardo, P. Cintia, A. Rossi, E. Massucco, P. Ferragina, D. Pedreschi, F. Giannotti, "A public data set of spatio-temporal match events in soccer competitions", Scientific Data 6, 236 (2019) | CC BY 4.0 per the Scientific Data article and the figshare records; the SoBigData catalogue lists it as non-commercial use only. We state both and redistribute no raw data | https://doi.org/10.1038/s41597-019-0247-7, files at https://figshare.com/collections/Soccer_match_event_dataset/4415000 | `scripts/calibrate.py` reads the 2017/18 Italian, Spanish, German and French first divisions. The English first division 2017/18 is excluded in code, the World Cup and Euro files are not read. Only aggregated averages (`studiodesk/sim/wyscout_averages.json`, values copied into `studiodesk/sim/calibration.json`) and a 16x12 xT grid (`studiodesk/facts/xt_grid.json`) are redistributed. No raw rows |
| MCP Python SDK (`mcp` 1.30.0) | MIT | https://github.com/modelcontextprotocol/python-sdk | The read-only MCP server `studiodesk/mcp_server.py` |
| ijson 3.3.0 | BSD 3-Clause | https://github.com/ICRAR/ijson | Streams the Wyscout JSON one match at a time in the offline calibration script only |
| Barlow Condensed font, weights 500/700/800, latin subset (Google Fonts v13) | SIL OFL 1.1 (`web/vendor/fonts/barlow-condensed/OFL.txt`) | https://github.com/jpt/barlow | Vendored woff2 files for the broadcast page and graphics |
| EBU OGraf v1 graphics specification | MIT | https://github.com/ebu/ograf | Our graphics in `web/graphics/` follow its manifest and Web Component API; no code copied |
| Babylon.js 9.29.0 (`babylonjs` and `babylonjs-loaders`, glTF 2 loader) | Apache 2.0 (`web/vendor/babylonjs/9.29.0/license.md`) | https://github.com/BabylonJS/Babylon.js, https://www.npmjs.com/package/babylonjs | Vendored UMD builds for the 3D view `web/sample3d.html` |
| Quaternius Universal Animation Library [Standard]: Mannequin and four locomotion clips | CC0 1.0 (`web/vendor/quaternius/LICENSE.txt`) | https://quaternius.itch.io/universal-animation-library | `web/vendor/quaternius/mannequin.glb`, stripped and quantised, for the 3D players. The kicks, first touches and dribble touches (`web/js/ball3d.js`) are procedural joint keys on its skeleton, not third-party animation |
| Quaternius Universal Base Characters [Standard]: male body, eyes, three hair meshes and their textures | CC0 1.0 (`web/vendor/players/LICENSE.txt`) | https://quaternius.itch.io/universal-base-characters | Rebound to the mannequin skeleton, cut into kit regions and decimated by `scripts/build_footballer.py` into `web/vendor/players/footballer.glb` (see `docs/players3d.md`) |
| Z-Image Turbo (Tongyi-MAI), text to image | Apache 2.0 (model card) | https://huggingface.co/Tongyi-MAI/Z-Image-Turbo | Trial only: generated the T-pose input image of `footballer-trellis.glb` (seed 3303, prompt in `docs/players3d.md`) through a Hugging Face Space. The image is not shipped |
| BiRefNet (ZhengPeng7), background removal | MIT | https://huggingface.co/ZhengPeng7/BiRefNet, Space https://huggingface.co/spaces/ZhengPeng7/BiRefNet_demo | Trial only: cut the input image out before TRELLIS.2, so the TRELLIS Space does not call its own remover (BRIA RMBG-2.0, CC BY-NC 4.0, not used) |
| TRELLIS.2-4B (Microsoft), image to 3D | MIT (model card and Space); it runs DINOv3 inside (DINOv3 License, https://github.com/facebookresearch/dinov3/blob/main/LICENSE.md, no terms on outputs) | https://huggingface.co/microsoft/TRELLIS.2-4B, Space https://huggingface.co/spaces/microsoft/TRELLIS.2 | Trial only: generated the mesh and texture behind `web/vendor/players/footballer-trellis.glb` (`?players=trellis`), rebound to our skeleton by `scripts/build_footballer.py --trellis` (`web/vendor/players/LICENSE.txt`) |
| Mesa lavapipe (`mesa-vulkan-swrast`, Alpine package) | MIT | https://www.mesa3d.org/ | Test container only (`tests/web/webgl`): software WebGL for the headless screenshots; not shipped |

## Runtime dependencies shipped in the container image

Installed from PyPI at the versions pinned in `pyproject.toml`; not vendored in the repository.

| What | Licence | Source |
|---|---|---|
| FastAPI | MIT | https://github.com/fastapi/fastapi |
| Starlette | BSD 3-Clause | https://github.com/encode/starlette |
| Uvicorn | BSD 3-Clause | https://github.com/encode/uvicorn |
| NumPy (wheels bundle OpenBLAS, BSD 3-Clause, and the GCC runtime libraries, GPL 3 with the runtime library exception) | BSD 3-Clause | https://github.com/numpy/numpy |
| HTTPX | BSD 3-Clause | https://github.com/encode/httpx |
| Pydantic | MIT | https://github.com/pydantic/pydantic |
| Azure Identity for Python | MIT | https://github.com/Azure/azure-sdk-for-python |
| Microsoft Agent Framework (agents extra) | MIT | https://github.com/microsoft/agent-framework |
| Python 3.12 official image on Debian bookworm (`python:3.12-slim-bookworm`) | PSF licence for Python; Debian packages under their own licences | https://hub.docker.com/_/python |
