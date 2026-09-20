/* 跨层可选回调。
 *
 * bootstrap.js 是所有模块的基础，不该反过来 import 上层。但它确实需要在
 * 几个时刻通知上层——打开自定义下拉时要关掉渠道操作菜单和主题菜单，改完
 * 密度要让设置页同步控件状态。
 *
 * 原来靠 `typeof closeUpstreamActionMenu === "function"` 做可选调用：全局
 * 脚本下这能工作，因为所有文件共享一个作用域。改成 ES 模块后它会永远取到
 * "undefined"——typeof 对未声明标识符不报错，只是静默跳过，功能悄悄失效
 * 而没有任何提示。那是最坏的失败方式。
 *
 * 所以把隐式的"碰巧同作用域"变成显式注册：上层模块 provide 自己的实现，
 * 底层 invoke 名字。仍然是可选的（没人注册就什么都不做），但这次是写出来
 * 的可选，不是撞运气。
 */

const hooks = new Map();

/** 注册一个实现。同名后注册的覆盖先注册的。 */
export function provide(name, fn) {
  hooks.set(name, fn);
}

/** 调用；没有注册过就返回 undefined。 */
export function invoke(name, ...args) {
  return hooks.get(name)?.(...args);
}

/** 用于需要区分"没注册"和"注册了但返回 undefined"的调用点。 */
export function hasHook(name) {
  return hooks.has(name);
}
