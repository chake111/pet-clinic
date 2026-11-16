package com.petclinic.security;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;
import java.time.Instant;

/**
 * 登录态。由 JwtUtils 从 token 解出，放进 UserContext 供全链路取用。
 * typ 区分两套登录体系，防止用户端 token 直接访问后台接口。
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class LoginUser {

    /** 用户端（宠物主人） */
    public static final String TYP_CLIENT = "CLIENT";
    /** 后台（管理员 / 医生） */
    public static final String TYP_ADMIN = "ADMIN";

    public static final String ROLE_ADMIN = "ADMIN";
    public static final String ROLE_DOCTOR = "DOCTOR";
    public static final String ROLE_USER = "USER";

    /** sys_user.id 或 admin_user.id，两套体系各自独立编号，故必须配合 typ 使用 */
    private Long id;
    private String username;
    private String name;
    private String avatar;
    private String typ;
    private String role;
    /** typ=ADMIN 且 role=DOCTOR 时指向 doctor.id，接诊工作台据此过滤数据 */
    private Long doctorId;
    /** 签发时的账号令牌版本，与库中当前值比对，用于改密后撤销旧令牌 */
    private Integer tokenVersion;
    /** 已验证令牌的到期时间，供长连接每帧校验。 */
    private Instant expiresAt;

    public boolean isAdmin() {
        return TYP_ADMIN.equals(typ) && ROLE_ADMIN.equals(role);
    }

    public boolean isDoctor() {
        return TYP_ADMIN.equals(typ) && ROLE_DOCTOR.equals(role);
    }

    public boolean isClient() {
        return TYP_CLIENT.equals(typ);
    }
}
