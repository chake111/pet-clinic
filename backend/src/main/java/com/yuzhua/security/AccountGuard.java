package com.yuzhua.security;

import com.yuzhua.entity.AdminUser;
import com.yuzhua.entity.SysUser;
import com.yuzhua.mapper.AdminUserMapper;
import com.yuzhua.mapper.SysUserMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import java.util.Objects;
import java.time.Instant;

/**
 * 账号在登录之后是否仍然可用。
 *
 * JWT 无状态，签出去的 token 在有效期内一直验得过，所以"管理员停用了这个账号"
 * 或"账号本人改了密码"都不会自动生效。每个入口检查令牌到期、账号状态、后台身份变化
 * 以及账号令牌版本；REST、握手和 WebSocket 收发共用。
 *
 * 令牌版本是改密的撤销手段：改密在事务内把版本 +1，此前签发的令牌版本落后，
 * 到这里一律判定失效。缺版本声明的旧令牌同样拒绝——无法证明它没被撤销。
 */
@Component
@RequiredArgsConstructor
public class AccountGuard {

    private final SysUserMapper sysUserMapper;
    private final AdminUserMapper adminUserMapper;

    public boolean active(LoginUser u) {
        if (u.getTyp() == null || u.getId() == null || u.getExpiresAt() == null
                || !Instant.now().isBefore(u.getExpiresAt())) {
            return false;
        }
        if (u.isClient()) {
            SysUser db = sysUserMapper.selectById(u.getId());
            return db != null && Integer.valueOf(1).equals(db.getStatus())
                    && versionMatches(db.getTokenVersion(), u.getTokenVersion());
        }
        if (!LoginUser.TYP_ADMIN.equals(u.getTyp())) {
            return false;
        }
        AdminUser db = adminUserMapper.selectById(u.getId());
        // 角色或医生绑定变化后，旧令牌必须重新登录才能使用新的身份。
        return db != null && Integer.valueOf(1).equals(db.getStatus())
                && Objects.equals(db.getRole(), u.getRole())
                && Objects.equals(db.getDoctorId(), u.getDoctorId())
                && versionMatches(db.getTokenVersion(), u.getTokenVersion());
    }

    /** 库里的版本非空且与令牌声明一致才放行；任一为空都当作已撤销 */
    private static boolean versionMatches(Integer dbVersion, Integer tokenVersion) {
        return dbVersion != null && tokenVersion != null && dbVersion.equals(tokenVersion);
    }
}
