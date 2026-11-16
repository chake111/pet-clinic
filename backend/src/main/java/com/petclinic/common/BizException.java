package com.petclinic.common;

import lombok.Getter;

/**
 * 业务异常。Service 层抛出后由 GlobalExceptionHandler 转成 Result.fail。
 * 区别于系统异常：业务异常的消息可以直接展示给用户。
 */
@Getter
public class BizException extends RuntimeException {

    private final int code;

    /** 默认按客户端可纠正的参数/状态错误处理；服务端故障请显式传 500。 */
    public BizException(String msg) {
        super(msg);
        this.code = 400;
    }

    public BizException(int code, String msg) {
        super(msg);
        this.code = code;
    }

    public static BizException notFound(String what) {
        return new BizException(404, what + "不存在");
    }

    public static BizException forbidden(String msg) {
        return new BizException(403, msg);
    }
}
