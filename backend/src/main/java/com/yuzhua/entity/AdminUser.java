package com.yuzhua.entity;

import com.baomidou.mybatisplus.annotation.*;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 后台账号。对应表 admin_user。
 * role=DOCTOR 时 doctorId 指向其医生身份，接诊工作台据此过滤数据。
 */
@Data
@TableName("admin_user")
public class AdminUser {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String username;

    /** BCrypt 哈希。WRITE_ONLY：入参可带（后台建号），出参永不序列化 */
    @TableField(select = false)
    @JsonProperty(access = JsonProperty.Access.WRITE_ONLY)
    private String password;

    private String realName;
    private String avatar;
    private String phone;
    private String email;

    /** ADMIN / DOCTOR */
    private String role;
    private Long doctorId;
    private Integer status;

    /** 令牌版本，含义同 sys_user.token_version：改密即递增，旧令牌随之失效 */
    @JsonIgnore
    private Integer tokenVersion;

    private LocalDateTime lastLoginTime;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createTime;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updateTime;

    /** 逻辑删除标记，不参与 JSON 契约 */
    @JsonIgnore
    @TableLogic
    @TableField(select = false)
    private Integer deleted;
}
