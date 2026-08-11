/* LoL PWA - bots.js: Bot.<name> objects, each { init(ctx), move(ctx) }.
   Loaded before lol.js. lol.js's game loop calls init() once on
   registration and move() on a regular interval for every bot listed in
   the participants URL param as `Bot.<name>`. */
'use strict';

window.Bot = window.Bot || {};

(function () {
  const ROAM_MARGIN = 200;             // world px kept clear of map edges when picking a roam point
  const FOLLOW_DIST = 220;             // world px: within this range of the favorite, switch to FOLLOW
  const REMEMBER_LIMIT = 8;            // recently-visited points kept, to avoid immediate backtracking
  const REVISIT_MIN_DIST = 400;        // don't roam to a point this close to a remembered one
  const FAVORITE_SWITCH_CHANCE = 0.15; // per move() tick, chance to drop the current favorite

  function dist(ax, ay, bx, by) { return Math.hypot(ax - bx, ay - by); }
  function clamp(v, lo, hi) { return Math.min(Math.max(v, lo), hi); }
  function randomIn(lo, hi) { return lo + Math.random() * (hi - lo); }

  function pickRoamPoint(ctx, memory) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const x = randomIn(ROAM_MARGIN, ctx.mapW - ROAM_MARGIN);
      const y = randomIn(ROAM_MARGIN, ctx.mapH - ROAM_MARGIN);
      const tooClose = memory.visited.some((p) => dist(x, y, p.x, p.y) < REVISIT_MIN_DIST);
      if (!tooClose) return { x, y };
    }
    return { x: randomIn(0, ctx.mapW), y: randomIn(0, ctx.mapH) };
  }

  function remember(memory, x, y) {
    memory.visited.push({ x, y });
    if (memory.visited.length > REMEMBER_LIMIT) memory.visited.shift();
  }

  function knownPlayerNames(ctx) {
    return Object.keys(ctx.players).filter((name) => name !== ctx.name);
  }

  function pickFavorite(ctx, memory) {
    const names = knownPlayerNames(ctx);
    memory.favorite = names.length ? names[Math.floor(Math.random() * names.length)] : null;
  }

  // Winnie: a pet-robot-style NPC. Roams the map, remembers recently-visited
  // spots, picks a favorite player from whoever it currently knows about,
  // seeks toward and then follows that favorite, and occasionally drops the
  // favorite to wander or pick a new one.
  window.Bot.Winnie = {
    init(ctx) {
      ctx.self.dir = 'down';
      ctx.self.memory = { visited: [], favorite: null, mode: 'ROAM' };
    },

    move(ctx) {
      const self = ctx.self;
      const memory = self.memory || (self.memory = { visited: [], favorite: null, mode: 'ROAM' });

      remember(memory, self.x, self.y);

      if (memory.favorite && Math.random() < FAVORITE_SWITCH_CHANCE) memory.favorite = null;
      if (!memory.favorite) pickFavorite(ctx, memory);

      const favPos = memory.favorite ? ctx.players[memory.favorite] : null;
      let target;

      if (favPos) {
        memory.mode = dist(self.x, self.y, favPos.x, favPos.y) <= FOLLOW_DIST ? 'FOLLOW' : 'SEEK';
        target = { x: clamp(favPos.x, 0, ctx.mapW), y: clamp(favPos.y, 0, ctx.mapH) };
      } else {
        memory.mode = 'ROAM';
        target = pickRoamPoint(ctx, memory);
      }

      self.targetX = target.x;
      self.targetY = target.y;
      self.walking = true;
    },
  };
})();
