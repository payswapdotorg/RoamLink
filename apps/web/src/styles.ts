/**
 * The customer web app's own stylesheet additions (RL-082/083), layered on
 * top of app-kit's {@link WARM_SHELL_STYLES} through htmlDocument's
 * `options.styles`. Same design system: warm-light, quiet, generous
 * whitespace, strong hierarchy; states carry text + data attributes, motion
 * respects prefers-reduced-motion.
 */
export const WEB_APP_STYLES = `
h2 { font-size: 1.15rem; margin: 1.25rem 0 0.5rem; }
h3 { font-size: 1rem; margin: 1rem 0 0.35rem; }
a { color: #5f5347; }
a:hover { color: #2d2a26; }
table { border-collapse: collapse; width: 100%; margin: 0.5rem 0 1rem; background: #fff; }
th, td { text-align: left; padding: 0.45rem 0.6rem; border: 1px solid #e8e2da; font-size: 0.9rem; vertical-align: top; }
th { background: #f4efe7; }
code { background: #f4efe7; padding: 0.05rem 0.3rem; border-radius: 4px; font-size: 0.85em; overflow-wrap: anywhere; }
.muted { color: #8a8078; font-size: 0.88rem; }
.panel { background: #fff; border: 1px solid #e8e2da; border-radius: 10px; padding: 1rem 1.1rem; margin: 0.5rem 0 1rem; }
.panel.error { border-color: #eec7c2; background: #fdf5f3; }
.panel.ok { border-color: #bfdcc8; background: #f6fbf7; }
.badge { display: inline-block; padding: 0.1rem 0.55rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; border: 1px solid transparent; }
.badge[data-freshness="FRESH"] { background: #e6f4ea; color: #1e5e3a; border-color: #bcdcc6; }
.badge[data-freshness="STALE"] { background: #fbf0d3; color: #713f12; border-color: #ecd9a4; }
.badge[data-freshness="UNKNOWN"] { background: #efeae2; color: #5f574e; border-color: #d9d1c5; }
.badge[data-evidence="EVIDENCED"] { background: #e6f4ea; color: #1e5e3a; border-color: #bcdcc6; }
.badge[data-evidence="UNEVIDENCED"] { background: #fbeae7; color: #7d3221; border-color: #efcbc3; }
.badge[data-severity="critical"] { background: #fbeae7; color: #7d3221; border-color: #efcbc3; }
.badge[data-severity="warning"] { background: #fbf0d3; color: #713f12; border-color: #ecd9a4; }
.badge[data-severity="info"] { background: #eef0e9; color: #3f4a38; border-color: #d6dcc9; }
.stages { list-style: none; padding: 0; margin: 0.25rem 0; }
.stages li { padding: 0.15rem 0; font-size: 0.9rem; }
.stages li[data-reached="false"] { color: #a49a90; }
button, select, input[type="text"], input[type="radio"] { font: inherit; color: inherit; }
button { background: #2d2a26; border: 1px solid #2d2a26; color: #fffdf9; border-radius: 8px; padding: 0.55rem 1.1rem; min-height: 44px; cursor: pointer; }
button:hover { background: #45403a; }
form label { display: block; margin: 0.5rem 0 0.15rem; }
form input[type="text"], form select { display: block; width: 100%; max-width: 22rem; padding: 0.5rem 0.6rem; min-height: 44px; box-sizing: border-box; border: 1px solid #d9d1c5; border-radius: 8px; background: #fff; }
.home-hero { background: #fff; border: 1px solid #e8e2da; border-radius: 14px; padding: 1.5rem 1.5rem 1.25rem; margin: 0 0 1.25rem; }
.home-hero-kicker { margin: 0 0 0.35rem; color: #8a8078; font-size: 0.85rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
.home-hero-headline { font-size: 1.5rem; line-height: 1.3; margin: 0 0 0.6rem; letter-spacing: -0.01em; }
.home-hero-facts { margin: 0 0 0.4rem; font-size: 0.95rem; color: #4d453e; }
.home-hero-evidence { margin: 0 0 0.8rem; color: #8a8078; font-size: 0.85rem; }
.home-facts { display: grid; gap: 1rem; grid-template-columns: 1fr; }
@media (min-width: 48rem) { .home-facts { grid-template-columns: 1fr 1fr; } }
.home-fact { background: #fff; border: 1px solid #e8e2da; border-radius: 12px; padding: 1rem 1.1rem; margin: 0; }
.home-fact h3 { margin-top: 0; }
.home-fact-primary { font-size: 1.02rem; font-weight: 600; margin: 0.2rem 0; }
.home-fact-muted { color: #6f665e; font-size: 0.9rem; margin: 0.25rem 0; }
.home-fact-action { margin: 0.5rem 0 0; }
.home-fact-action a { font-weight: 600; }
.home-fact-list { margin: 0.3rem 0; padding-left: 1.1rem; }
.home-fact-list li { margin: 0.25rem 0; font-size: 0.92rem; }
.home-getting-started { background: #f6f1e8; border: 1px solid #e3d8c6; border-radius: 12px; padding: 1rem 1.1rem; margin-top: 1.25rem; }
.onboarding { max-width: 40rem; margin: 0 auto; }
.onboarding-progress { margin-bottom: 1rem; }
.onboarding-steps { list-style: none; display: flex; gap: 0.6rem; padding: 0; margin: 0.25rem 0 0; flex-wrap: wrap; }
.onboarding-steps li { color: #a49a90; font-size: 0.85rem; padding: 0.25rem 0.6rem; border-radius: 999px; background: #f1ebe1; min-height: 32px; display: flex; align-items: center; }
.onboarding-steps li[aria-current="step"] { background: #2d2a26; color: #fffdf9; font-weight: 600; }
.onboarding-body { background: #fff; border: 1px solid #e8e2da; border-radius: 14px; padding: 1.5rem; }
.onboarding-lede { font-size: 1.05rem; line-height: 1.55; }
.onboarding-points { padding-left: 1.2rem; line-height: 1.7; }
.onboarding-primary-action { display: inline-flex; align-items: center; justify-content: center; }
.onboarding-goal-list, .onboarding-device-list { border: 0; padding: 0; margin: 0.75rem 0; display: grid; gap: 0.6rem; }
.onboarding-goal, .onboarding-device { display: flex; gap: 0.7rem; align-items: flex-start; background: #fdfbf7; border: 1px solid #e8e2da; border-radius: 10px; padding: 0.8rem 0.9rem; cursor: pointer; }
.onboarding-goal:hover, .onboarding-device:hover { border-color: #c9b989; }
.onboarding-goal input, .onboarding-device input { margin-top: 0.3rem; width: 1.1rem; height: 1.1rem; }
.onboarding-goal-text { display: flex; flex-direction: column; gap: 0.15rem; }
.onboarding-goal-text strong { font-weight: 600; }
.onboarding-confirm dt { font-weight: 600; margin-top: 0.6rem; }
.onboarding-confirm dd { margin: 0.15rem 0 0; color: #4d453e; }
.onboarding-notice { background: #fbf0d3; border: 1px solid #ecd9a4; color: #713f12; border-radius: 8px; padding: 0.6rem 0.8rem; }
.activity-list { list-style: none; margin: 0.5rem 0 1rem; padding: 0; display: grid; gap: 0.6rem; }
.activity-item { background: #fff; border: 1px solid #e8e2da; border-radius: 10px; padding: 0.75rem 0.9rem; }
.activity-item p { margin: 0.15rem 0; }
.more-list { list-style: none; margin: 0.75rem 0; padding: 0; display: grid; gap: 0.6rem; }
.more-item-link { display: flex; flex-direction: column; gap: 0.2rem; background: #fff; border: 1px solid #e8e2da; border-radius: 10px; padding: 0.85rem 1rem; min-height: 44px; text-decoration: none; }
.more-item-link:hover { border-color: #c9b989; }
/* RL-084 connectivity center */
.fact-list { margin: 0.5rem 0 0; display: grid; gap: 0.45rem; }
.fact-row { display: grid; grid-template-columns: minmax(9rem, 14rem) 1fr; gap: 0.35rem 0.9rem; align-items: baseline; }
.fact-row dt { font-weight: 600; color: #4d453e; }
.fact-row dd { margin: 0; min-width: 0; }
.journey { list-style: none; margin: 0.75rem 0 1.25rem; padding: 0; display: grid; gap: 0.6rem; }
.journey-stage { background: #fff; border: 1px solid #e8e2da; border-left-width: 4px; border-radius: 10px; padding: 0.75rem 0.95rem; }
.journey-stage p { margin: 0.15rem 0; }
.journey-stage[data-lifecycle-state="reached"] { border-left-color: #7fae8f; }
.journey-stage[data-lifecycle-state="waiting"] { border-left-color: #d9b45c; }
.journey-stage[data-lifecycle-state="not-recorded"] { border-left-color: #cfc6ba; }
.journey-state { font-weight: 600; }
.journey-stage[data-lifecycle-state="reached"] .journey-state { color: #1e5e3a; }
.journey-stage[data-lifecycle-state="waiting"] .journey-state { color: #7a5b12; }
.journey-stage[data-lifecycle-state="not-recorded"] .journey-state { color: #6f665e; }
.journey-fact { color: #6f665e; font-size: 0.88rem; }
.disclosure { background: #fffdf9; border: 1px solid #e8e2da; border-radius: 10px; padding: 0; margin: 0.6rem 0 1rem; }
.disclosure summary { cursor: pointer; padding: 0.75rem 1rem; min-height: 44px; box-sizing: border-box; font-weight: 600; color: #4d453e; }
.disclosure summary:hover { color: #2d2a26; }
.disclosure > *:not(summary) { padding: 0 1rem 0.9rem; }
.disclosure > h4:first-of-type { margin: 0.4rem 0 0; padding-top: 0; }
.support-escape { margin: 0.75rem 0 0.25rem; }
.support-escape a { display: inline-flex; align-items: center; min-height: 44px; padding: 0.35rem 0.9rem; background: #fdfbf7; border: 1px solid #d9c9a8; border-radius: 8px; font-weight: 600; text-decoration: none; }
.support-escape a:hover { border-color: #c9b989; }
.observation-list { list-style: none; margin: 0.5rem 0 1rem; padding: 0; display: grid; gap: 0.6rem; }
.observation-item { background: #fff; border: 1px solid #e8e2da; border-radius: 10px; padding: 0.75rem 0.9rem; }
.observation-item p { margin: 0.15rem 0; }
/* RL-085 activity narrative */
.kind-chip { display: inline-block; padding: 0.1rem 0.55rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; background: #f1ebe1; color: #4d453e; border: 1px solid #e3d8c6; }
.kind-chip[data-kind="delivery"] { background: #e6f4ea; color: #1e5e3a; border-color: #bcdcc6; }
.kind-chip[data-kind="recovery"] { background: #eef0e9; color: #3f4a38; border-color: #d6dcc9; }
.kind-chip[data-kind="request"] { background: #fbf0d3; color: #713f12; border-color: #ecd9a4; }
.activity-what { font-size: 0.95rem; }
.evidence-list { margin: 0.3rem 0; padding-left: 1.2rem; color: #6f665e; font-size: 0.85rem; }
.evidence-list li { margin: 0.15rem 0; }
.needs-you { font-weight: 600; color: #7d3221; }
/* RL-086 goals journey */
.goal-list { list-style: none; margin: 0.5rem 0 1rem; padding: 0; display: grid; gap: 0.75rem; }
.goal-card { background: #fff; border: 1px solid #e8e2da; border-radius: 10px; padding: 0.85rem 1rem; }
.goal-card h3 { margin: 0 0 0.3rem; }
.goal-card p { margin: 0.2rem 0; }
.goal-preferences { color: #4d453e; }
.preference-list { border: 1px solid #e8e2da; border-radius: 10px; padding: 0.6rem 0.8rem; margin: 0.6rem 0; display: grid; gap: 0.25rem; }
.preference-option { display: flex; gap: 0.55rem; align-items: center; min-height: 44px; font-size: 0.95rem; }
.preference-option input { width: 1.1rem; height: 1.1rem; }
/* RL-087 device capability */
.fallback-list { padding-left: 1.2rem; line-height: 1.65; }
.fallback-list li { margin: 0.25rem 0; }
/* RL-088 responsive + accessibility refinements */
.table-wrap { overflow-x: auto; margin: 0.5rem 0 1rem; -webkit-overflow-scrolling: touch; }
.table-wrap table { margin: 0; }
.table-wrap:focus-visible { outline: 3px solid #b07f3e; outline-offset: 2px; }
.journey-state, .kind-chip, .badge { max-width: 100%; }
@media (max-width: 40rem) {
  .home-hero { padding: 1.1rem 1rem 1rem; }
  .fact-row { grid-template-columns: 1fr; gap: 0.1rem 0; }
  .journey-stage, .goal-card, .activity-item, .observation-item { padding: 0.7rem 0.8rem; }
  .disclosure summary { padding: 0.7rem 0.8rem; }
  .shell-header-inner { padding: 0.6rem 0.9rem; }
  td { overflow-wrap: anywhere; }
  .table-wrap { margin: 0.5rem 0 1rem -0.2rem; padding-left: 0.2rem; }
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`.trim();
