# Gotchas

Known issues and fixes for the dashboard.

## Connection

- **Dashboard not receiving events**: Agents POST to `http://host.docker.internal:3737`. If using a non-default port, set `DASHBOARD_PORT` env var before starting NanoClaw. Also check that the container has host gateway access.
- **SSE disconnects**: The browser reconnects automatically via `EventSource`. If events stop arriving, check the dashboard server process is still running.
- **CORS**: The dashboard server serves its own static files — no CORS issues. If you embed the dashboard in another app, you'll need to add CORS headers.

## Pixel Office

- **Characters not appearing**: Characters are assigned when agents send hook events. No events = no characters. Start an agent task to populate.
- **Layout reset**: Custom layout is saved to `dashboard/public/assets/default-layout-1.json`. If the file is deleted or corrupted, the dashboard falls back to auto-layout.
- **Sprite rendering**: Uses `image-rendering: pixelated` CSS. If sprites look blurry, ensure the browser supports this (all modern browsers do).

## Timeline

- **Events not showing**: Hook events are stored in-memory. Dashboard restart clears the timeline. Historical data comes from SQLite (messages table).
- **Large event volume**: With many agents and frequent tool calls, the timeline can accumulate thousands of entries. The UI virtualizes rendering but the SSE stream can lag. Consider filtering by group.
- **Session flow view**: Clicking "Session" on a timeline entry opens the flow view. If no session_id is present in hook data, the entry won't be linkable.

## Performance

- **Memory**: Dashboard stores hook events in-memory (no persistence). Long-running dashboards with heavy agent activity can accumulate >100MB. Restart to reclaim.
- **SQLite locking**: Dashboard reads from the same SQLite DB as the main NanoClaw process. Reads are non-blocking (WAL mode) but if the DB is locked, API calls may timeout. This is rare.
- **Port conflict**: Default port 3737. If another process uses it, set `DASHBOARD_PORT=3738` or similar.
