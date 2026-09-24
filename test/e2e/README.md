# End-to-end suite

Needs Docker. Not part of `npm test` — it is `npm run test:e2e`, because a suite
that silently skips when a container is missing is a suite that reports green on
a broken read path.

The server runs with `security.strategy = ./tokensecurity`, exactly as the board
does, because the simulator refuses to start without logging in: its `connect()`
POSTs `/signalk/v1/auth/login` and calls `raise_for_status()` before it opens its
delta socket. `ADMINUSER=admin:admin` in the compose provisions that account on
first boot. Consequence: unauthenticated REST GETs are refused too, so the suite
needs a token of its own.

One command does all of it (up, login, wait for a first frame, test, down):

    test/e2e/run.sh            # KEEP=1 leaves the stack running

By hand:

    docker compose -f test/e2e/docker-compose.yml up -d
    export SIGNALK_E2E_URL=http://localhost:3100
    export SIGNALK_E2E_TOKEN=$(curl -s -X POST "$SIGNALK_E2E_URL/signalk/v1/auth/login" \
      -H 'content-type: application/json' -d '{"username":"admin","password":"admin"}' \
      | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).token))")
    # give the simulator ~30s to publish a first full frame, then
    npm run test:e2e
    docker compose -f test/e2e/docker-compose.yml down -v

`SIGNALK_E2E_URL` or `SIGNALK_E2E_TOKEN` unset => the suite fails with an explicit
message rather than skipping.
