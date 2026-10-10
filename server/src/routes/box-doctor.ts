// The machine doctor (server/src/box-doctor.ts) over HTTP: GET reads the box and records nothing
// (Project Hydra's facts as the last pass read them); POST /sync runs the timer's pass now, asks
// Project Hydra afresh, and brings the incidents in line.
import { checkBox, runBoxDoctorPass } from '../box-doctor'
import { app } from '../http-app'

app.get('/api/box-doctor', async (c) => c.json(await checkBox()))

app.post('/api/box-doctor/sync', async (c) =>
  c.json(await runBoxDoctorPass(undefined, { hydra: 'fresh' })),
)
