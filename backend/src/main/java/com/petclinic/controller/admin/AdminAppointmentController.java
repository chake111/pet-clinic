package com.petclinic.controller.admin;

import com.petclinic.common.PageResult;
import com.petclinic.common.Result;
import com.petclinic.dto.AppointmentQuery;
import com.petclinic.dto.CancelForm;
import com.petclinic.security.LoginUser;
import com.petclinic.security.RequireRole;
import com.petclinic.service.AppointmentService;
import com.petclinic.vo.AppointmentVo;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

/**
 * 后台预约订单：管理员看全院，医生账号只会拿到自己的接诊单（收窄在 Service 里做）。
 *
 * 接诊/结束是临床动作，按 R4 只允许医生账号（责任医生归属仍在服务层用 requireStaffMayTouch 校）；
 * 管理员保留查看与"代患者取消待接诊单"这类前台场景，不代替医生接诊或结束就诊。
 *
 * 类名加 Admin 前缀是为了不和 client 包下的 AppointmentController 撞 bean 名。
 */
@Tag(name = "管理后台-预约订单")
@RestController
@RequestMapping("/admin/appointment")
@RequiredArgsConstructor
public class AdminAppointmentController {

    private final AppointmentService appointmentService;

    @Operation(summary = "订单分页（医生账号自动限定为本人）")
    @GetMapping("/page")
    public Result<PageResult<AppointmentVo>> page(AppointmentQuery query) {
        return Result.ok(appointmentService.pageForStaff(query));
    }

    @Operation(summary = "订单详情（含患者联系方式）")
    @GetMapping("/{id}")
    public Result<AppointmentVo> detail(@PathVariable Long id) {
        return Result.ok(appointmentService.detail(id));
    }

    @Operation(summary = "接诊：待接诊 + 已支付才能开始（仅医生账号，R4）")
    @RequireRole(LoginUser.ROLE_DOCTOR)
    @PostMapping("/{id}/accept")
    public Result<Void> accept(@PathVariable Long id) {
        appointmentService.accept(id);
        return Result.ok("已开始接诊", null);
    }

    @Operation(summary = "结束问诊（仅医生账号，R4）")
    @RequireRole(LoginUser.ROLE_DOCTOR)
    @PostMapping("/{id}/finish")
    public Result<Void> finish(@PathVariable Long id) {
        appointmentService.finish(id);
        return Result.ok("问诊已结束", null);
    }

    @Operation(summary = "代患者取消（号源退回）")
    @PostMapping("/{id}/cancel")
    public Result<Void> cancel(@PathVariable Long id, @RequestBody(required = false) CancelForm req) {
        appointmentService.cancelByStaff(id, req == null ? null : req.getReason());
        return Result.ok("已取消，号源已退回", null);
    }
}
