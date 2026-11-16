package com.petclinic.common;

import jakarta.servlet.http.HttpServletRequest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.BindException;
import org.springframework.validation.FieldError;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.stream.Collectors;

/**
 * 全局异常处理：把异常统一转成 Result，避免把堆栈暴露给前端。
 * 注意返回体 code 与 HTTP 状态码解耦——走到这里的异常 HTTP 始终 200，业务状态由 body.code 表达，
 * 前端 axios 对这类响应只看 body.code。没走到应用的 HTTP/代理/网络层错误（代理 502、连接失败、
 * 超时）不在这套约定内，由前端 axios 的错误分支另行提示。
 */
@Slf4j
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(BizException.class)
    public Result<Void> handleBiz(BizException e) {
        log.warn("业务异常: {}", e.getMessage());
        return Result.fail(e.getCode(), e.getMessage());
    }

    /** @Valid 校验 RequestBody 失败 */
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public Result<Void> handleValid(MethodArgumentNotValidException e) {
        String msg = e.getBindingResult().getFieldErrors().stream()
                .map(FieldError::getDefaultMessage)
                .collect(Collectors.joining("；"));
        return Result.fail(400, msg.isEmpty() ? "参数校验失败" : msg);
    }

    /** 表单/查询参数绑定校验失败 */
    @ExceptionHandler(BindException.class)
    public Result<Void> handleBind(BindException e) {
        String msg = e.getFieldErrors().stream()
                .map(FieldError::getDefaultMessage)
                .collect(Collectors.joining("；"));
        return Result.fail(400, msg.isEmpty() ? "参数校验失败" : msg);
    }

    @ExceptionHandler(MissingServletRequestParameterException.class)
    public Result<Void> handleMissingParam(MissingServletRequestParameterException e) {
        log.warn("缺少请求参数: {}", e.getParameterName());
        return Result.fail(400, "操作未成功，请刷新后重试");
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public Result<Void> handleUnreadable(HttpMessageNotReadableException e) {
        log.warn("请求体解析失败: {}", e.getMessage());
        return Result.fail(400, "提交的内容有误，请刷新后重试");
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public Result<Void> handleUpload(MaxUploadSizeExceededException e) {
        return Result.fail(400, "上传文件过大");
    }

    /**
     * 路径没对上任何 Controller。没有这个处理器的话会掉进下面的兜底分支返回 500，
     * 联调时看起来像后端挂了，实际只是 URL 写错。
     */
    @ExceptionHandler({NoResourceFoundException.class, NoHandlerFoundException.class})
    public Result<Void> handleNotFound(HttpServletRequest request, Exception e) {
        log.warn("接口不存在 uri={}", request.getRequestURI());
        return Result.fail(404, "请求的地址不存在或已失效");
    }

    /** 用 GET 调 POST 接口之类的前端调用方式错误 */
    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public Result<Void> handleMethod(HttpServletRequest request, HttpRequestMethodNotSupportedException e) {
        log.warn("请求方式错误 method={} uri={}", e.getMethod(), request.getRequestURI());
        return Result.fail(405, "操作未成功，请刷新后重试");
    }

    /**
     * 唯一键冲突（并发插入同一手机号等）。上层 Service 不用每处单独 try/catch，
     * 统一在这里转成用户能看懂的提示。
     */
    @ExceptionHandler(DuplicateKeyException.class)
    public Result<Void> handleDuplicateKey(HttpServletRequest request, DuplicateKeyException e) {
        log.warn("唯一键冲突 uri={}", request.getRequestURI());
        return Result.fail(400, "数据已存在，请刷新后重试");
    }

    /**
     * 兜底：非预期异常不泄漏内部信息，只记日志。
     *
     * <p>响应体里带上本次请求的追踪号——它同时出现在 {@code X-Trace-Id} 响应头和本次请求的
     * 每一行日志里。用户截个图报障就能直接 grep 到那一条堆栈；原先只记 url，同一个接口
     * 反复失败时日志里是一串一模一样的行，分不清是哪一次。追踪号是随机串，不含业务信息，
     * 暴露它不越过"不泄漏内部信息"这条边界。
     */
    @ExceptionHandler(Exception.class)
    public Result<Void> handleOther(HttpServletRequest request, Exception e) {
        String traceId = TraceIdFilter.current();
        log.error("系统异常 traceId={} method={} uri={}", traceId, request.getMethod(),
                request.getRequestURI(), e);
        String msg = traceId == null ? "服务器繁忙，请稍后再试"
                : "服务器繁忙，请稍后再试（追踪号 " + traceId + "）";
        return Result.fail(500, msg);
    }
}
