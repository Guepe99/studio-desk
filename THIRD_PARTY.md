# Third-party material

| What | Licence | Source | How we use it |
|---|---|---|---|
| socceraction (SPADL format, xT grid method) | MIT | https://github.com/ML-KULeuven/socceraction | Offline calibration script only; not shipped in the runtime |
| Wyscout public event data: L. Pappalardo, P. Cintia, A. Rossi, E. Massucco, P. Ferragina, D. Pedreschi, F. Giannotti, "A public data set of spatio-temporal match events in soccer competitions", Scientific Data 6, 236 (2019) | CC BY 4.0 per the Scientific Data article and the figshare records; the SoBigData catalogue lists it as non-commercial use only. We state both and redistribute no raw data | https://doi.org/10.1038/s41597-019-0247-7, files at https://figshare.com/collections/Soccer_match_event_dataset/4415000 | `scripts/calibrate.py` reads the 2017/18 Italian, Spanish, German and French first divisions. The English first division 2017/18 is excluded in code, the World Cup and Euro files are not read. Only aggregated averages (`studiodesk/sim/wyscout_averages.json`, values copied into `studiodesk/sim/calibration.json`) and a 16x12 xT grid (`studiodesk/facts/xt_grid.json`) are redistributed. No raw rows |
| MCP Python SDK (`mcp` 1.30.0) | MIT | https://github.com/modelcontextprotocol/python-sdk | The read-only MCP server `studiodesk/mcp_server.py` |
| ijson 3.3.0 | BSD 3-Clause | https://github.com/ICRAR/ijson | Streams the Wyscout JSON one match at a time in the offline calibration script only |
