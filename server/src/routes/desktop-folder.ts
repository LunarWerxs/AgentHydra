import { moveDesktopChatFolder } from '../desktop-folder-move'
import { app } from '../http-app'
import { jsonBody } from '../route-helpers'

// POST /api/sessions/:id/desktop-folder - move ONE Desktop Code chat to another working folder in its
// own profile. The order and every refusal live in desktop-folder-move.ts; this route only hands it the body.
app.post('/api/sessions/:id/desktop-folder', async (c) => {
  const body = await jsonBody(c)
  const out = await moveDesktopChatFolder({
    sessionId: c.req.param('id'),
    instanceRef: body.instance_ref,
    cwd: body.cwd,
  })
  return c.json(out.body, out.status as 200)
})
