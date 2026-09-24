// Version drift (server/src/version-drift.ts) over HTTP: GET reads the fleet's Claude versions and
// touches nothing; POST /sync runs the same pass the 10-minute timer runs, now.
import { app } from '../http-app'
import { checkVersionDrift, runVersionDriftPass } from '../version-drift'

app.get('/api/versions', async (c) => c.json(await checkVersionDrift()))

app.post('/api/versions/sync', async (c) => c.json(await runVersionDriftPass()))
