package com.petclinic.controller.client;

import com.petclinic.common.Result;
import com.petclinic.dto.AuthDto;
import com.petclinic.entity.SysUser;
import com.petclinic.service.SysUserService;
import com.petclinic.vo.LoginVo;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

/**
 * 用户端认证。登出由前端丢弃 token 完成，服务端不持有会话，故不设 logout 接口。
 */
@Tag(name = "用户端-认证")
@RestController
@RequestMapping("/client/auth")
@RequiredArgsConstructor
public class AuthController {

    private final SysUserService sysUserService;

    @Operation(summary = "注册（成功即登录，直接返回 token）")
    @PostMapping("/register")
    public Result<LoginVo> register(@Valid @RequestBody AuthDto.Register req) {
        return Result.ok("注册成功", sysUserService.register(req));
    }

    @Operation(summary = "登录")
    @PostMapping("/login")
    public Result<LoginVo> login(@Valid @RequestBody AuthDto.Login req) {
        return Result.ok(sysUserService.login(req));
    }

    @Operation(summary = "当前登录用户资料")
    @GetMapping("/profile")
    public Result<SysUser> profile() {
        return Result.ok(sysUserService.current());
    }

    @Operation(summary = "修改资料")
    @PutMapping("/profile")
    public Result<Void> updateProfile(@Valid @RequestBody AuthDto.UpdateProfile req) {
        sysUserService.updateProfile(req);
        return Result.ok("已保存", null);
    }

    @Operation(summary = "修改密码")
    @PutMapping("/password")
    public Result<Void> changePassword(@Valid @RequestBody AuthDto.ChangePassword req) {
        sysUserService.changePassword(req);
        return Result.ok("密码已修改，请重新登录", null);
    }
}
