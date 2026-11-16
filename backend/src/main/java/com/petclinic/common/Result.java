package com.petclinic.common;

import lombok.Getter;

/**
 * 统一响应包装。code=200 表示成功，前端 axios 拦截器据此判断。
 */
@Getter
public class Result<T> {

    private final Integer code;
    private final String msg;
    private final T data;

    private Result(Integer code, String msg, T data) {
        this.code = code;
        this.msg = msg;
        this.data = data;
    }

    public static <T> Result<T> ok(T data) {
        return new Result<>(200, "操作成功", data);
    }

    public static <T> Result<T> ok(String msg, T data) {
        return new Result<>(200, msg, data);
    }

    public static <T> Result<T> fail(int code, String msg) {
        return new Result<>(code, msg, null);
    }

    /** 未登录或 token 失效，前端据此跳登录页 */
    public static <T> Result<T> unauthorized(String msg) {
        return new Result<>(401, msg, null);
    }

    /** 已登录但无权访问（角色不符 / 越权访问他人数据） */
    public static <T> Result<T> forbidden(String msg) {
        return new Result<>(403, msg, null);
    }
}
