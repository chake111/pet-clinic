package com.petclinic.controller.admin;

import com.petclinic.common.Result;
import com.petclinic.dto.AuthDto;
import com.petclinic.service.AdminUserService;
import com.petclinic.vo.LoginVo;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

/**
 * 后台认证。管理员与医生共用这一个入口，靠 role 区分能进哪些菜单。
 */
@Tag(name = "后台-认证")
@RestController
@RequestMapping("/admin/auth")
@RequiredArgsConstructor
public class AdminAuthController {

    private final AdminUserService adminUserService;

    @Operation(summary = "后台登录")
    @PostMapping("/login")
    public Result<LoginVo> login(@Valid @RequestBody AuthDto.Login req) {
        return Result.ok(adminUserService.login(req));
    }

    @Operation(summary = "当前登录账号")
    @GetMapping("/profile")
    public Result<LoginVo> profile() {
        return Result.ok(adminUserService.current());
    }

    @Operation(summary = "修改密码")
    @PutMapping("/password")
    public Result<Void> changePassword(@Valid @RequestBody AuthDto.ChangePassword req) {
        adminUserService.changePassword(req);
        return Result.ok("密码已修改，请重新登录", null);
    }
}
