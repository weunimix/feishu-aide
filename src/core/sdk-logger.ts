import type * as lark from "@larksuiteoapi/node-sdk";

/**
 * 吞掉 SDK 自身的日志。
 *
 * 不能靠 `loggerLevel: LoggerLevel.fatal`：该枚举的 fatal 是 0，而 Client 用
 * `params.loggerLevel || LoggerLevel.info` 取默认值，0 会被当成「没传」而落到
 * info，于是 SDK 照常打印错误——它的错误日志带着请求与响应体，写请求的 body
 * 就是用户的正文。传入一个不接收任何消息的 logger 才是真正静音。
 */
export const silentLogger: lark.Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};
