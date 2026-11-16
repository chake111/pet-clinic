package com.petclinic.controller.admin;

import com.petclinic.common.PageResult;
import com.petclinic.common.Result;
import com.petclinic.dto.UserQuery;
import com.petclinic.entity.SysUser;
import com.petclinic.security.LoginUser;
import com.petclinic.security.RequireRole;
import com.petclinic.service.SysUserService;
import com.petclinic.vo.UserDetailVo;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 用户账号管理（宠物主人）。
 *
 * 禁用/恢复改的是 sys_user.status：被禁用账号的在线 token 会在下一个请求
 * 被拦截器回查 status 时挡掉（与医生账号停用同一套口径）。
 * 详情里带该用户的宠物档案与最近预约，便于核对异常账号。
 */
@Tag(name = "管理后台-用户")
@RestController
@RequestMapping("/admin/user")
@RequiredArgsConstructor
@RequireRole(LoginUser.ROLE_ADMIN)
public class AdminUserController {

    private final SysUserService sysUserService;

    @Operation(summary = "用户分页（昵称/手机号/账号、状态）")
    @GetMapping("/page")
    public Result<PageResult<SysUser>> page(UserQuery query) {
        return Result.ok(sysUserService.pageForAdmin(query));
    }

    @Operation(summary = "用户详情：账号 + 宠物档案 + 最近预约")
    @GetMapping("/{id}")
    public Result<UserDetailVo> detail(@PathVariable Long id) {
        return Result.ok(sysUserService.detailForAdmin(id));
    }

    @Operation(summary = "禁用/恢复账号。status: 0 禁用 1 正常")
    @PutMapping("/{id}/status")
    public Result<Void> changeStatus(@PathVariable Long id, @RequestParam Integer status) {
        sysUserService.changeStatus(id, status);
        return Result.ok("已更新", null);
    }
}
