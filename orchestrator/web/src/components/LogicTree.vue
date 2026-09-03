<script setup lang="ts">
// THE LOGIC TREE, verbatim from scripts/dashboard.html (the Python dashboard's own drawing).
// Regenerate rather than edit: `python scripts/remote.py --extract-tree` rewrites this file
// from that source, so the two dashboards can never show two different trees.
</script>

<template>
  <div class="logic-tree space-y-2 overflow-x-auto">
        <h3>1 · THE GATE — “what state is this chat in?” (deterministic code over transcript bytes + the daemon’s dossier)</h3>
        <svg viewBox="0 0 1120 460" role="img" aria-label="Gate decision tree">
          <defs>
            <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="var(--baseline)"/>
            </marker>
          </defs>
          <!-- start -->
          <rect class="box" x="10" y="205" width="140" height="50" rx="8"/>
          <text x="80" y="226" text-anchor="middle" class="h">Every visible chat</text>
          <text x="80" y="242" text-anchor="middle" class="t2">(archived ones excluded)</text>
  
          <path class="edge" d="M150,230 H190" marker-end="url(#arr)"/>
  
          <!-- resolve -->
          <rect class="box" x="192" y="196" width="168" height="68" rx="8"/>
          <text x="276" y="218" text-anchor="middle" class="h">Resolve identity</text>
          <text x="276" y="234" text-anchor="middle" class="t2">dossier: instance, lineage,</text>
          <text x="276" y="248" text-anchor="middle" class="t2">live process, archive flag</text>
  
          <!-- resolve failure -->
          <path class="edge" d="M276,264 V330" marker-end="url(#arr)"/>
          <text x="284" y="296" class="lbl">no match / two rows share a title</text>
          <rect class="box crit-b" x="192" y="332" width="240" height="52" rx="8"/>
          <text x="204" y="352" class="h">⛔ STOP — deterministic refusal</text>
          <text x="204" y="368" class="t2">counted once, never retried (v2 retried these forever)</text>
  
          <path class="edge" d="M360,230 H400" marker-end="url(#arr)"/>
  
          <!-- live? -->
          <rect class="box accent-b" x="402" y="202" width="128" height="56" rx="8"/>
          <text x="466" y="226" text-anchor="middle" class="h">Live writer</text>
          <text x="466" y="242" text-anchor="middle" class="h">attached?</text>
  
          <!-- yes: running -->
          <path class="edge" d="M466,202 V96 H560" marker-end="url(#arr)"/>
          <text x="474" y="120" class="lbl">yes → RUNNING</text>
          <text x="474" y="134" class="lbl">(never archive)</text>
          <rect class="box" x="562" y="20" width="250" height="44" rx="8"/>
          <text x="574" y="38" class="h">WORKING — leave it alone</text>
          <text x="574" y="54" class="t2">quiet &lt;3 min, or a turn is genuinely in flight</text>
  
          <rect class="box warn-b" x="562" y="74" width="250" height="52" rx="8"/>
          <text x="574" y="92" class="h">⚠ IDLE — waiting, not working</text>
          <text x="574" y="106" class="t2">finished its turn, quiet ≥3 min →</text>
          <text x="574" y="119" class="t2">judgment: answer / nudge / hand off</text>
  
          <rect class="box serious-b" x="562" y="136" width="250" height="52" rx="8"/>
          <text x="574" y="154" class="h">⚠ STUCK? — flag for a human</text>
          <text x="574" y="168" class="t2">ends on an unanswered shell call, quiet ≥30 min</text>
          <text x="574" y="181" class="t2">(a long build looks the same — read it, never act)</text>
  
          <!-- no: tail -->
          <path class="edge" d="M530,230 H580" marker-end="url(#arr)"/>
          <text x="536" y="222" class="lbl">no</text>
          <rect class="box" x="582" y="204" width="150" height="52" rx="8"/>
          <text x="657" y="224" text-anchor="middle" class="h">Read the transcript</text>
          <text x="657" y="240" text-anchor="middle" class="t2">tail (the real last turn)</text>
  
          <!-- crashed -->
          <path class="edge" d="M732,218 H830 V150 H848" marker-end="url(#arr)"/>
          <text x="754" y="205" class="lbl">turn never completed / API error</text>
          <rect class="box serious-b" x="850" y="122" width="258" height="56" rx="8"/>
          <text x="862" y="141" class="h">⟳ CRASHED — resume candidate</text>
          <text x="862" y="156" class="t2">mid-turn death · usage limit · overload ·</text>
          <text x="862" y="170" class="t2">refusal · API error (kind is named)</text>
  
          <!-- human -->
          <path class="edge" d="M732,230 H848" marker-end="url(#arr)"/>
          <text x="843" y="248" text-anchor="end" class="lbl">a person pressed stop</text>
          <rect class="box" x="850" y="208" width="258" height="44" rx="8"/>
          <text x="862" y="226" class="h">🧍 FINISHED · human — theirs</text>
          <text x="862" y="242" class="t2">deliberately interrupted; their move, not automation’s</text>
  
          <!-- finished split -->
          <path class="edge" d="M732,242 H800 V320 H848" marker-end="url(#arr)"/>
          <text x="843" y="274" text-anchor="end" class="lbl">completed assistant turn —</text>
          <text x="843" y="288" text-anchor="end" class="lbl">read the recap:</text>
          <rect class="box warn-b" x="850" y="282" width="258" height="70" rx="8"/>
          <text x="862" y="301" class="h">✋ WAITING ON A PERSON</text>
          <text x="862" y="316" class="t2">offers to carry on (“say the word…”, “let me</text>
          <text x="862" y="329" class="t2">know if…”) · or ends on a “?” · or recap ≠ done</text>
          <text x="862" y="344" class="t2">→ ANSWER it. Never archive.</text>
  
          <path class="edge" d="M800,320 V400 H848" marker-end="url(#arr)"/>
          <rect class="box good-b" x="850" y="376" width="258" height="56" rx="8"/>
          <text x="862" y="395" class="h">✓ ARCHIVE CANDIDATE</text>
          <text x="862" y="410" class="t2">recap says done · asks nothing · offers nothing</text>
          <text x="862" y="424" class="t2">→ the ONLY state allowed into the act rails ↓</text>
        </svg>
  
        <h3>2 · THE ACT RAILS — what stands between “archive candidate” and an actual archive</h3>
        <svg viewBox="0 0 1120 250" role="img" aria-label="Act rails pipeline">
          <rect class="box good-b" x="10" y="30" width="150" height="46" rx="8"/>
          <text x="85" y="49" text-anchor="middle" class="h">✓ archive candidate</text>
          <text x="85" y="65" text-anchor="middle" class="t2">(from the gate above)</text>
  
          <path class="edge" d="M160,53 H196" marker-end="url(#arr)"/>
  
          <rect class="box" x="198" y="18" width="182" height="70" rx="8"/>
          <text x="289" y="38" text-anchor="middle" class="h">Breaker check</text>
          <text x="289" y="54" text-anchor="middle" class="t2">≥4 attempts in 6 h, or one</text>
          <text x="289" y="68" text-anchor="middle" class="t2">deterministic failure before?</text>
          <path class="edge" d="M289,88 V138" marker-end="url(#arr)"/>
          <text x="296" y="116" class="lbl">yes</text>
          <rect class="box crit-b" x="198" y="140" width="182" height="52" rx="8"/>
          <text x="210" y="159" class="h">⏸ HELD BACK — loudly</text>
          <text x="210" y="174" class="t2">says why + when it frees up; a</text>
          <text x="210" y="187" class="t2">person’s direct word still overrides</text>
  
          <path class="edge" d="M380,53 H416" marker-end="url(#arr)"/>
          <text x="384" y="45" class="lbl">no</text>
  
          <rect class="box" x="418" y="18" width="182" height="70" rx="8"/>
          <text x="509" y="38" text-anchor="middle" class="h">Re-check at T−0</text>
          <text x="509" y="54" text-anchor="middle" class="t2">fresh dossier read: any movement</text>
          <text x="509" y="68" text-anchor="middle" class="t2">or a new live writer since deciding?</text>
          <path class="edge" d="M509,88 V138" marker-end="url(#arr)"/>
          <text x="516" y="116" class="lbl">moved</text>
          <rect class="box warn-b" x="418" y="140" width="182" height="52" rx="8"/>
          <text x="430" y="159" class="h">✋ ABORT</text>
          <text x="430" y="174" class="t2">a person’s word beats any verdict —</text>
          <text x="430" y="187" class="t2">re-decide against the new state</text>
  
          <path class="edge" d="M600,53 H636" marker-end="url(#arr)"/>
          <text x="604" y="45" class="lbl">clean</text>
  
          <rect class="box" x="638" y="18" width="160" height="70" rx="8"/>
          <text x="718" y="38" text-anchor="middle" class="h">Act</text>
          <text x="718" y="54" text-anchor="middle" class="t2">attempt counted FIRST,</text>
          <text x="718" y="68" text-anchor="middle" class="t2">then POST desktop-archive</text>
          <path class="edge" d="M718,88 V138" marker-end="url(#arr)"/>
          <text x="725" y="116" class="lbl">app running?</text>
          <rect class="box serious-b" x="638" y="140" width="220" height="66" rx="8"/>
          <text x="650" y="159" class="h">⚠ flag written — NOT success</text>
          <text x="650" y="174" class="t2">a running app keeps its chat list in</text>
          <text x="650" y="187" class="t2">memory: on screen until restart, and</text>
          <text x="650" y="200" class="t2">it can re-save the flag away (exit 7)</text>
  
          <path class="edge" d="M798,53 H834" marker-end="url(#arr)"/>
  
          <rect class="box" x="836" y="18" width="130" height="70" rx="8"/>
          <text x="901" y="38" text-anchor="middle" class="h">Verify</text>
          <text x="901" y="54" text-anchor="middle" class="t2">read the dossier</text>
          <text x="901" y="68" text-anchor="middle" class="t2">again — did it land?</text>
  
          <path class="edge" d="M966,42 H1002" marker-end="url(#arr)"/>
          <rect class="box good-b" x="1004" y="18" width="106" height="48" rx="8"/>
          <text x="1016" y="37" class="h">✓ VERIFIED</text>
          <text x="1016" y="53" class="t2">success clears</text>
  
          <path class="edge" d="M901,88 V138" marker-end="url(#arr)"/>
          <text x="908" y="116" class="lbl">no</text>
          <rect class="box crit-b" x="880" y="140" width="200" height="52" rx="8"/>
          <text x="892" y="159" class="h">✗ NOT landed — say so</text>
          <text x="892" y="174" class="t2">attempt stays on the ledger, so a</text>
          <text x="892" y="187" class="t2">futile loop trips the breaker above</text>
        </svg>
        <p class="diagram-note">Migrate and rename run the same shape (resolve → refuse live → breaker → act → verify);
        migrate additionally treats “superseded” and any daemon 400 as deterministic stops, and rename drives the app’s
        real UI-Automation click, so it needs the app open and the chat visible.</p>
  </div>
</template>
