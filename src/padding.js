// 取景留白（padding）这一件事从 2026-07 起就只有一个定义：界面上方压下来多少、左侧的街区清单占多宽、
// 下方那条控制条多高。现版把它交给 MapLibre，新引擎过去**根本没有这一维**，所以同一串 `#map=` 在两边
// 落的画面差 140×70 px（2026-10-16 实测，桌面 1440×960）。这张表现在两边共用，差值由 `tests/padding.test.js`
// 与浏览器那两册的取景判据一起钉住。
//
// 三个分支读的是视口，不是引擎：手机 `innerWidth <= 760`，极矮横屏 `568~1000 px 宽且 ≤500 px 高`，其余算桌面。
export const isMobileViewport = () => globalThis.innerWidth <= 760;
export const isLandscapeViewport = () => globalThis.matchMedia('(min-width: 568px) and (max-width: 1000px) and (max-height: 500px)').matches;

/**
 * 这一场的取景留白。`panelOpen` 是左侧那份街区清单开没开——新引擎那一侧它永远是 false，
 * 因为那份清单在这一侧还是灰的（`src/main.js` 那句边界说明），灰掉的控件不该占走 280 px。
 */
export function viewportPadding(panelOpen = false) {
  if (isLandscapeViewport()) {
    return { top: 180, left: 20, right: panelOpen ? 330 : 20, bottom: 65 };
  }
  if (isMobileViewport()) {
    return { top: 255, left: 15, right: 15, bottom: panelOpen ? Math.round(globalThis.innerHeight * 0.38 + 129) : 110 };
  }
  return { top: 200, left: 280, right: panelOpen ? 360 : 0, bottom: 60 };
}

/**
 * 留白把"地理中心落在屏幕哪一格"挪走了多少 CSS 像素：MapLibre 把中心放在抠掉四边留白之后那块窗口的正中，
 * 于是相对画布正中偏出 ((left − right) / 2, (top − bottom) / 2)。桌面那一档就是 (140, 70)。
 */
export const paddingShift = (padding) => ({ x: (padding.left - padding.right) / 2, y: (padding.top - padding.bottom) / 2 });
