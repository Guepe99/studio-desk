// Plans built a slice at a time. BallPlan, Awareness and Scene3D.planning are generators that yield
// between pieces of work of well under a millisecond; the same code runs whole (run) or spread
// over the page's frames (slices), so both give the same plan.
//
//   run(steps)                    -> the generator's return value, computed now
//   const job = slices(steps, ms, done)   tasks of about ms each between frames, then done(value)
//   job.stop()                    drops it;  job.finish()  runs what is left now and calls done
export const SLICE_MS = 8;   // half a 60 fps frame: the picture keeps its rate on a machine with time to spare

export function run(steps) {
  for (;;) { const r = steps.next(); if (r.done) return r.value; }
}

export function slices(steps, ms, done) {
  let timer = null;
  const end = (value) => { timer = null; job.stop = job.finish = () => {}; done(value); };
  const go = () => {
    const t = performance.now();
    for (;;) {
      const r = steps.next();
      if (r.done) return end(r.value);
      if (performance.now() - t >= ms) break;
    }
    timer = setTimeout(go, 0);
  };
  const job = {
    stop() { clearTimeout(timer); timer = null; job.stop = job.finish = () => {}; },
    finish() { clearTimeout(timer); end(run(steps)); },
  };
  timer = setTimeout(go, 0);
  return job;
}
