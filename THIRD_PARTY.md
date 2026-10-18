# Third-party material

| What | Licence | Source | How we use it |
|---|---|---|---|
| socceraction (SPADL format, xT grid method) | MIT | https://github.com/ML-KULeuven/socceraction | Offline calibration script only; not shipped in the runtime |
| Wyscout public event data (Pappalardo et al., 2019) | CC BY 4.0 per the Scientific Data article; the SoBigData catalogue lists it as non-commercial | https://doi.org/10.1038/s41597-019-0247-7 | Only aggregate averages and a 16x12 xT grid, stored as JSON. No raw rows. The 2017/18 English league season is excluded in code |
| MCP Python SDK (`mcp` 1.30.0) | MIT | https://github.com/modelcontextprotocol/python-sdk | The read-only MCP server `studiodesk/mcp_server.py` |
| Barlow Condensed font, weights 500/700/800, latin subset (Google Fonts v13) | SIL OFL 1.1 (`web/vendor/fonts/barlow-condensed/OFL.txt`) | https://github.com/jpt/barlow | Vendored woff2 files for the broadcast page and graphics |
| EBU OGraf v1 graphics specification | MIT | https://github.com/ebu/ograf | Our graphics in `web/graphics/` follow its manifest and Web Component API; no code copied |
