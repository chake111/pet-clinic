package com.petclinic.controller.client;

import com.petclinic.common.PageResult;
import com.petclinic.common.Result;
import com.petclinic.dto.AppointmentForm;
import com.petclinic.dto.CancelForm;
import com.petclinic.dto.PageQuery;
import com.petclinic.entity.MedicalRecord;
import com.petclinic.service.AppointmentService;
import com.petclinic.service.MedicalRecordService;
import com.petclinic.vo.AppointmentVo;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

/**
 * 用户端预约：下单 → 模拟支付 → 查看 / 取消，以及回看这次问诊的病历。
 *
 * 所有接口只认登录态里的 userId，前端传 userId 一律无效；
 * 下单金额同样由服务端按医生挂号费回填，不接受入参。
 */
@Tag(name = "用户端-预约问诊")
@RestController
@RequestMapping("/client/appointment")
@RequiredArgsConstructor
public class AppointmentController {

    private final AppointmentService appointmentService;
    private final MedicalRecordService recordService;

    @Operation(summary = "下单预约（占用号源，30 分钟内需支付）",
            description = "可选请求头 Idempotency-Key（8–64 字符，仅限字母数字与 . _ : -）；"
                    + "同一用户携带同一个键重放时返回原单，不重复占号")
    @PostMapping
    public Result<AppointmentVo> create(@Valid @RequestBody AppointmentForm req,
                                        @RequestHeader(value = "Idempotency-Key", required = false) String idemKey) {
        return Result.ok("预约成功，请在有效期内支付", appointmentService.create(req, idemKey));
    }

    @Operation(summary = "模拟支付")
    @PostMapping("/{id}/pay")
    public Result<AppointmentVo> pay(@PathVariable Long id) {
        return Result.ok("支付成功", appointmentService.pay(id));
    }

    @Operation(summary = "取消预约（号源退回池子，已支付则标记退款）")
    @PostMapping("/{id}/cancel")
    public Result<Void> cancel(@PathVariable Long id, @RequestBody(required = false) CancelForm req) {
        appointmentService.cancelByUser(id, req == null ? null : req.getReason());
        return Result.ok("已取消，号源已退回", null);
    }

    @Operation(summary = "我的预约分页")
    @GetMapping("/page")
    public Result<PageResult<AppointmentVo>> page(@RequestParam(required = false) Integer status,
                                                  PageQuery query) {
        return Result.ok(appointmentService.pageMine(status, query));
    }

    @Operation(summary = "预约详情")
    @GetMapping("/{id}")
    public Result<AppointmentVo> detail(@PathVariable Long id) {
        return Result.ok(appointmentService.detail(id));
    }

    /** 一张预约最多一份病历；医生还没写时 data 整个省略，前端按"无病历"渲染 */
    @Operation(summary = "这次预约的病历（医生未写则为空）")
    @GetMapping("/{id}/record")
    public Result<MedicalRecord> record(@PathVariable Long id) {
        return Result.ok(recordService.ofAppointmentForOwner(id));
    }
}
