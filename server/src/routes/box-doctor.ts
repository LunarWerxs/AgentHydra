// The machine doctor (server/src/box-doctor.ts) over HTTP: GET reads the box and records nothing;
// POST /sync runs the same pass the 15-minute timer runs, now, and brings its incidents in line.
import { checkBox, runBoxDoctorPass } from '../box-doctor'
import { app } from '../http-app'

app.get('/api/box-doctor', async (c) => c.json(await checkBox()))

app.post('/api/box-doctor/sync', async (c) => c.json(await runBoxDoctorPass()))
