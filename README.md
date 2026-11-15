# LogicalSexualSalamander

Website where users enter links to furniture items as well as the dimensions of the room.
The AI will get the dimensions, shape, price, materials, colour from the links.
The user can then move the furniture about in a virtual room to see how it fits and if they like it.
Room settings also let users choose a wall colour with the colour picker, toggle transparent walls in the 3D view, and choose a wood, carpet, or marble floor texture.

Tasks:
- Generating the virtual room
- Getting the furniture data from the links
- Handling of the virtual room and interactions

## Run the app and configure extraction

Use Node.js 20.6 or newer. For metadata/spec parsing without an LLM, run:

```sh
node server.js
```

Open `http://10.247.153.150:3000`. The room starts empty; paste IKEA product URLs one per line and select **Extract details**. The server fetches IKEA product pages directly using standard HTTP requests and only follows redirects to IKEA domains. It does not attempt to bypass access restrictions; if IKEA returns an error such as HTTP 403, use a permitted access method or check the retailer's terms. 
IF ASKS FOR USER + PASSWORD; USER = ANYTHING, PASSWORD = 'Durhack2026'

## Use Room For Improvement from other devices

3D generation runs through the computer that runs `node server.js` (it holds the SSH tunnel to the GPU server). To let phones and other computers use it, set `ROOMFIT_HOST=0.0.0.0` in `.env`, restart the server, and open one of the network addresses it prints (for example `http://192.168.1.20:3000`) on the other device while it is on the same Wi-Fi. Allow Node.js through Windows Firewall on private networks if prompted. Set `ROOMFIT_PASSWORD` to require a password; browsers ask for it once (any username). The GPU API runs one generation at a time, so a second device that starts one while another is running gets an error and should retry. The GitHub Pages copy cannot generate models.

## Generate furniture models

The main Room For Improvement UI keeps the orbitable 3D room and room designer. Select an extracted furniture item and use **AI 3D model** to generate a GLB from its product image; generated models replace the item's procedural 3D shape, while its 2D placement and dimensions remain editable. Models can also be downloaded or reused from the saved-model list.

Start `node server.js`; it launches the local TRELLIS bridge automatically via `ai_server_trellis.py` unless `ROOMFIT_AUTOSTART_TRELLIS=false` is set. For a remote GPU API, set `TRELLIS_SSH_TARGET=user@host` in `.env`; startup creates a tunnel from local `TRELLIS_API_URL` (default `http://127.0.0.1:7861`) to the remote `TRELLIS_REMOTE_API_PORT` (default `7861`). The remote TRELLIS API must already be running. SSH key authentication is required; set `TRELLIS_SSH_IDENTITY_FILE` if the key is not in the SSH client's default locations or agent. The SSH client may prompt to trust the host key. Set `TRELLIS_SSH_PORT` for a non-default SSH port. The bridge listens on port 8766 by default; set `TRELLIS_PORT` if needed. GitHub Pages cannot run these local services.

## GitHub Pages

The static room editor and 2D/3D room views can be hosted on GitHub Pages. Pages serves `index.html`, which forwards to `Roomfit.html`. Product-link extraction is not available from Pages alone: it calls the `/api/` endpoints in `server.js`, and GitHub Pages cannot run that Node server. To enable extraction, deploy the API separately, update the frontend to call its URL, and configure the API's CORS policy; keep provider credentials on the server.

Use the **Arrange furniture** and **Design room** tabs to switch between the main view and room editor. Choose Rectangle, L-shape, or Bay in the editor, or start a custom outline; drag room corners, add or remove corners, and click a wall to add a door or window. Set room dimensions, door width, hinge side, and swing direction; windows have editable width, sill height, and glass height. Preset and editor-added windows use the same framed, lightly tinted glass and wall opening in 3D. Doorways retain a wall lintel above the frame, and the ceiling light casts soft shadows from room and furniture surfaces.

Room dimensions, shape, doors, windows, wall colour, transparency, and floor texture are saved in the browser so they remain when moving between Room For Improvement and the room editor. **Reset room design** restores the editor's default rectangle, dimensions, and openings. Furniture is not saved automatically; use **Design files** to download a JSON file containing the room and furniture layout, or load a previously saved file.

Appearance, design-file controls, keyboard hints, and detailed editor lists are collapsed until needed. Core room dimensions, furniture sizing and colour, and primary placement actions remain visible; less-used item and door options are in expandable sections.

`product-extractor.js` reads JSON-LD, product specifications, accordion text, and IKEA image candidates from the returned HTML. The optional LLM endpoint can help recover specifications not found by these parsers. To configure one, copy `.env.example` to `.env` and set:

- `ROOMFIT_LLM_URL` receives the extractor's `{ url, markdown, existing, schema }` request and must return the product object matching that schema. Dimensions must be in centimetres.

Set `ROOMFIT_LLM_TOKEN` if the provider requires a bearer token. Without an LLM endpoint the app still extracts JSON-LD, Open Graph data, and labeled dimensions from IKEA's returned HTML, using estimates for anything missing. Keep credentials only in `.env`, which is ignored by Git. Before exposing this server publicly, add authentication and rate limiting.

The browser module `product-extractor.js` checks Product JSON-LD, labeled dimensions in specification tables and definition lists, and the page's extracted text (including accordion content present in the fetched HTML) before asking the optional structured-output adapter for remaining gaps. It recognizes labeled width/depth/height values and dimension triples whose axis order is stated, and selects the first matching IKEA product-gallery image rather than preferring a PNG dimension diagram. The selected image is shown as a thumbnail in the furniture list and sampled for a dominant colour; when image sampling fails, the app keeps the metadata/URL/category colour fallback and reports a warning.

