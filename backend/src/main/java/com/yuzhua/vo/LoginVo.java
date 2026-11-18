package com.yuzhua.vo;

import lombok.Data;

/**
 * 登录成功返回体。前端存 token 后，用 user 直接渲染头部与权限菜单，
 * 不必再打一次"取当前用户"接口。
 */
@Data
public class LoginVo {

    private String token;

    /** sys_user.id 或 admin_user.id */
    private Long id;
    private String username;
    /** 展示名：昵称或真实姓名 */
    private String name;
    private String avatar;
    private String phone;
    private String email;

    /** CLIENT / ADMIN */
    private String typ;
    /** USER / ADMIN / DOCTOR */
    private String role;
    /** 后台医生账号绑定的 doctor.id，前端据此决定是否展示接诊工作台 */
    private Long doctorId;
    private String doctorName;
    private String departmentName;
}
