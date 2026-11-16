package com.petclinic.entity;

import com.baomidou.mybatisplus.annotation.*;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonProperty;
import lombok.Data;

import java.time.LocalDate;
import java.time.LocalDateTime;

/**
 * 注册用户（宠物主人）。对应表 sys_user。
 */
@Data
@TableName("sys_user")
public class SysUser {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String username;

    /** BCrypt 哈希。WRITE_ONLY：入参可带（后台建号），出参永不序列化 */
    @TableField(select = false)
    @JsonProperty(access = JsonProperty.Access.WRITE_ONLY)
    private String password;

    private String nickname;
    private String avatar;
    private String phone;
    private String email;
    private Integer gender;
    private LocalDate birthday;
    private String city;
    private String address;

    /** 0 禁用 1 正常 */
    private Integer status;

    /**
     * 令牌版本：签进 JWT，每次改密递增。旧令牌版本落后即视为已撤销。
     * 不参与 JSON 契约，避免把内部撤销机制暴露给前端。
     */
    @JsonIgnore
    private Integer tokenVersion;

    private String remark;
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
