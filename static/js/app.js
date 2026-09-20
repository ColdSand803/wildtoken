/* 控制台入口。
 *
 * 每个模块自己 import 需要的东西，真正的执行顺序由依赖图决定，不由这里的
 * 顺序决定——列在这里只是为了把带副作用的模块都拉起来（它们在顶层绑事件、
 * 读 localStorage、装初始视图），漏一个那部分界面就没人接管。
 *
 * 顺序仍按原来 script 标签的顺序写，方便和历史对照。
 */

import "./bootstrap.js";
import "./conversation.js";
import "./dashboard.js";
import "./shell.js";
import "./upstreams.js";
import "./logs.js";
import "./models.js";
import "./tokens.js";
import "./groups.js";
import "./events.js";
